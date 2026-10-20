import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import type { UIMessageChunk } from "ai";
import { promptForRun, type EmitFrame } from "./claude-code";
import { CodexChunkTranslator, record } from "./codex-to-ui-chunks";
import { liveMessageChunk, type LiveMessageInbox } from "./live-messages";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function codexConfig(
  input: HarnessStreamInputWire,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  const readonly =
    input.mode === "plan" || input.toolApprovalLevel === "readonly";
  for (const server of [
    { name: "studio", ...input.mcp },
    ...(input.orgMcps ?? []),
  ]) {
    if (server.name in servers)
      throw new Error("Codex MCP server names must be distinct");
    servers[server.name] = {
      url: server.url,
      http_headers: server.headers,
      required: server.name === "studio",
      ...(readonly
        ? {
            enabled: server.name === "studio",
            enabled_tools: [
              "web_search",
              "deep_research",
              "research_result",
            ].filter(
              (name) =>
                !input.toolAllowlist || input.toolAllowlist.includes(name),
            ),
          }
        : input.toolAllowlist
          ? { enabled_tools: input.toolAllowlist }
          : {}),
    };
  }
  return { mcp_servers: servers };
}

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  return `{${Object.entries(record(value))
    .map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`)
    .join(",")}}`;
}

/** A separate config/auth directory per run prevents concurrent threads from changing each other's MCP credentials. */
export async function runCodex(
  input: HarnessStreamInputWire,
  emit: EmitFrame,
  _turnStartedAt?: number,
  inbox?: LiveMessageInbox,
): Promise<void> {
  const translator = new CodexChunkTranslator();
  const home =
    process.env.CODEX_HOME ?? join(process.env.HOME ?? ".", ".codex");
  const pointer = join(
    home,
    "deco-sessions",
    input.threadId.replace(/[^A-Za-z0-9_-]/g, "_"),
  );
  let runtime: string | undefined;
  let authWatcher: FSWatcher | undefined;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let started = false;
  let seed = process.env.STUDIO_CODEX_AUTH_JSON;
  let previousHash = seed ? hash(seed) : undefined;
  let syncedContent = seed;
  let syncFlight = Promise.resolve();
  // Keep subscription credentials out of Codex's shell/tool environment.
  const env = { ...process.env };
  delete env.STUDIO_CODEX_AUTH_JSON;
  delete env.HARNESS_RUNNER_PERSISTENT;
  const model = process.env.CODEX_MODEL;
  try {
    if (input.agent.disallowedTools?.length)
      throw new Error(
        "Codex does not support per-tool built-in restrictions for this run.",
      );
    await mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "deco-sessions"), { recursive: true, mode: 0o700 });
    runtime = await mkdtemp(join(home, ".studio-runtime-"));
    await symlink(join(home, "sessions"), join(runtime, "sessions"));
    const config = codexConfig(input);
    const providerUrl = process.env.OPENAI_BASE_URL;
    if (seed)
      await writeFile(join(runtime, "auth.json"), seed, { mode: 0o600 });
    else {
      if (!process.env.CODEX_API_KEY || !providerUrl)
        throw new Error(
          "Codex needs a ChatGPT subscription or Responses API credential.",
        );
      config.model_provider = "studio";
      config.model_providers = {
        studio: {
          name: "Studio",
          base_url: providerUrl,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
        },
      };
    }
    config.cli_auth_credentials_store = "file";
    config.forced_login_method = seed ? "chatgpt" : "api";
    // The daemon already prefetched shared skills onto local disk for Claude's
    // plugins. Codex discovers the same files in its own user skills directory.
    const skills = join(runtime, "skills");
    await mkdir(skills, { mode: 0o700 });
    for (const plugin of (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? "")
      .split(":")
      .filter(Boolean)) {
      const source = join(plugin, "skills");
      const entries = await readdir(source, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await symlink(join(source, entry.name), join(skills, entry.name)).catch(
          (error: unknown) => {
            if (record(error).code !== "EEXIST") throw error;
          },
        );
      }
    }
    await writeFile(
      join(runtime, "config.toml"),
      Object.entries(config)
        .map(([key, value]) => `${key}=${toml(value)}`)
        .join("\n"),
      { mode: 0o600 },
    );
    if (seed) {
      authWatcher = watch(runtime, (_, name) => {
        if (name === "auth.json")
          syncFlight = syncFlight.then(syncCredentials).catch(() => {
            console.error("[codex] refreshed credentials could not be saved");
          });
      });
      authWatcher.on("error", () =>
        console.error("[codex] credential file watch failed"),
      );
    }
    proc = Bun.spawn(
      [process.env.CODEX_PATH ?? "codex", "app-server", "--listen", "stdio://"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...env, CODEX_HOME: runtime },
      },
    );
    const stdin = proc.stdin;
    const stdout = proc.stdout;
    if (
      typeof stdin === "number" ||
      !stdin ||
      !stdout ||
      typeof stdout === "number"
    )
      throw new Error("Codex pipes are unavailable");
    let nextId = 1;
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const send = (message: unknown) => {
      stdin.write(JSON.stringify(message) + "\n");
      stdin.flush();
    };
    const request = (
      method: string,
      params: unknown,
      timeoutMs = 60000,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    let threadId = "";
    let turnId = "";
    let turnEnded = false;
    const liveDeliveries = new Map<string, Promise<boolean>>();
    const liveRead = new Set<string>();
    let finish: ((turn: Record<string, unknown>) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // A startup failure can reject before the turn is awaited.
    void done.catch(() => {});
    const pump = (async () => {
      try {
        const lines = jsonLines(stdout);
        for await (const line of lines) {
          const message = record(JSON.parse(line));
          if (typeof message.method !== "string") {
            if (typeof message.id !== "number") continue;
            const waiter = pending.get(message.id);
            if (!waiter) continue;
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            if (message.error)
              waiter.reject(
                new Error(
                  `Codex request failed. Check your provider connection or relink the ChatGPT subscription.`,
                ),
              );
            else waiter.resolve(record(message.result));
            continue;
          }
          const params = record(message.params);
          if ("id" in message) {
            if (
              message.method === "item/tool/requestUserInput" &&
              params.threadId === threadId
            ) {
              emit({ chunks: translator.question(params) });
              // End on the question; the answer arrives as the next Studio turn.
              void request("turn/interrupt", { threadId, turnId }).catch(
                (err) => fail?.(err),
              );
            } else {
              send({
                id: message.id,
                error: {
                  code: -32601,
                  message: "This client does not grant interactive approvals",
                },
              });
            }
            continue;
          }
          if (params.threadId && params.threadId !== threadId) continue;
          if (message.method === "turn/started")
            turnId = String(record(params.turn).id ?? "");
          if (params.turnId && params.turnId !== turnId) continue;
          if (message.method === "turn/completed") {
            turnEnded = true;
            inbox?.close();
            finish?.(record(params.turn));
            continue;
          }
          if (started) {
            const item = record(params.item);
            if (
              (message.method === "item/started" ||
                message.method === "item/completed") &&
              item.type === "userMessage" &&
              typeof item.clientId === "string" &&
              liveDeliveries.has(item.clientId) &&
              !liveRead.has(item.clientId)
            ) {
              liveRead.add(item.clientId);
              emit({ chunks: [liveMessageChunk(item.clientId)] });
            }
            const chunks = translator.translate(message.method, params);
            if (chunks.length) emit({ chunks });
          }
        }
        throw new Error("Codex app-server stopped before completing the turn");
      } catch (error) {
        const err =
          error instanceof Error ? error : new Error("Codex protocol failed");
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        pending.clear();
        fail?.(err);
      }
    })();
    try {
      await request("initialize", {
        clientInfo: { name: "studio", title: "Studio", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized" });
      const readonly =
        input.mode === "plan" || input.toolApprovalLevel === "readonly";
      const options = {
        cwd: input.workspace.cwd ?? "/repo",
        model,
        approvalPolicy: "never",
        sandbox: readonly ? "read-only" : "danger-full-access",
        developerInstructions: [
          input.agent.instructions,
          "The organization filesystem is mounted at /app/org/. Wait for commands to finish before ending your turn. Ask questions with request_user_input. The user's response arrives in the next turn.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      const previous = input.resume
        ? ""
        : await readFile(pointer, "utf8").catch(() => "");
      // An unreadable or missing saved transcript is a fresh conversation. Do not retry a turn that already started.
      let thread: Record<string, unknown>;
      if (previous.trim()) {
        thread = await request("thread/resume", {
          ...options,
          threadId: previous.trim(),
          excludeTurns: true,
        }).catch(() => request("thread/start", options));
      } else thread = await request("thread/start", options);
      threadId = String(record(thread.thread).id ?? "");
      if (!threadId) throw new Error("Codex did not return a thread ID");
      const start: UIMessageChunk[] = [
        { type: "start", messageId: `msg_${crypto.randomUUID()}` },
        { type: "start-step" },
      ];
      emit({ chunks: start });
      started = true;
      const inputItems: unknown[] = [
        { type: "text", text: promptForRun(input), text_elements: [] },
      ];
      const parts = input.userMessage.parts;
      if (Array.isArray(parts))
        for (const part of parts) {
          const file = record(part);
          if (
            file.type === "file" &&
            typeof file.mediaType === "string" &&
            file.mediaType.startsWith("image/") &&
            typeof file.url === "string"
          )
            inputItems.push({ type: "image", url: file.url });
        }
      const turn = await request("turn/start", {
        threadId,
        input: inputItems,
        ...(input.mode === "plan" && model
          ? {
              collaborationMode: {
                mode: "plan",
                settings: {
                  model,
                  reasoning_effort: "medium",
                  developer_instructions: null,
                },
              },
            }
          : {}),
      });
      turnId = String(record(turn.turn).id ?? turnId);
      if (input.liveMessages && !turnEnded) {
        inbox?.open((message) => {
          if (turnEnded || translator.awaitingUser || !turnId) return false;
          const existing = liveDeliveries.get(message.id);
          if (existing) return existing;
          const expectedTurnId = turnId;
          const delivery = request(
            "turn/steer",
            {
              threadId,
              expectedTurnId,
              clientUserMessageId: message.id,
              input: [{ type: "text", text: message.text, text_elements: [] }],
            },
            20000,
          )
            .then((result) => result.turnId === expectedTurnId)
            .catch(() => liveRead.has(message.id));
          liveDeliveries.set(message.id, delivery);
          return delivery;
        });
      }
      const result = await done;
      // The native completion can race a steer response. Let its ack settle
      // before the runner exits, so Studio can queue any refused message.
      await Promise.all(liveDeliveries.values());
      const failed =
        result.status === "failed" ||
        (result.status === "interrupted" && !translator.awaitingUser);
      const tempPointer = `${pointer}.${crypto.randomUUID()}`;
      await writeFile(tempPointer, threadId, { mode: 0o600 });
      await rename(tempPointer, pointer);
      if (failed)
        throw new Error(
          "Codex turn failed. Check your provider connection or relink the ChatGPT subscription.",
        );
      emit({
        chunks: [
          ...translator.close(),
          { type: "finish-step" },
          {
            type: "finish",
            finishReason: translator.awaitingUser ? "tool-calls" : "stop",
            messageMetadata: {
              ...(translator.usage ? { usage: translator.usage } : {}),
              ...(translator.contextWindow
                ? { modelLimits: { contextWindow: translator.contextWindow } }
                : {}),
            },
          },
        ],
      });
    } finally {
      inbox?.close();
      proc.kill();
      await proc.exited;
      await pump;
      authWatcher?.close();
      await syncFlight;
      await syncCredentials().catch(() =>
        console.error("[codex] refreshed credentials could not be saved"),
      );
    }
  } catch (error) {
    // CLI errors may include request details. Never echo configuration or credential values.
    const safe =
      error instanceof SyntaxError
        ? "Codex returned an invalid protocol frame"
        : error instanceof Error
          ? error.message
          : "Codex failed";
    emit({
      chunks: started
        ? [
            ...translator.close(),
            { type: "error", errorText: safe },
            { type: "finish-step" },
            { type: "finish", finishReason: "error" },
          ]
        : [],
      error: { code: "harness_crashed", message: safe },
    });
  } finally {
    inbox?.close();
    proc?.kill();
    authWatcher?.close();
    await syncFlight;
    if (runtime) await rm(runtime, { recursive: true, force: true });
    seed = undefined;
  }

  async function syncCredentials(): Promise<void> {
    if (!runtime || !previousHash) return;
    const updated = await readFile(join(runtime, "auth.json"), "utf8").catch(
      () => undefined,
    );
    if (!updated || updated === syncedContent) return;
    // This callback uses the scoped run credential directly; it never enters
    // the model's tool results or the daemon's replayable chunk log.
    const url = new URL(input.mcp.url);
    if (!/\/mcp\/thread\/[^/]+$/.test(url.pathname)) return;
    url.pathname = url.pathname.replace(
      /\/mcp\/thread\/[^/]+$/,
      "/tools/CODEX_SUBSCRIPTION_SYNC",
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { ...input.mcp.headers, "content-type": "application/json" },
      body: JSON.stringify({ previousHash, authJson: updated }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Credential sync failed");
    const result = record(await response.json());
    syncedContent = updated;
    previousHash =
      result.updated === true &&
      typeof result.authHash === "string" &&
      /^[a-f0-9]{64}$/.test(result.authHash)
        ? result.authHash
        : undefined;
  }
}

async function* jsonLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024)
        throw new Error("Codex emitted an oversized protocol frame");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
