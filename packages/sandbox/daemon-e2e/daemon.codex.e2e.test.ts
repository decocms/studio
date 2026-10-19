import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authHeaders,
  type Daemon,
  HOOK_TIMEOUT_MS,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const codex = process.env.CODEX_PATH ?? Bun.which("codex");

/** Real daemon, runner, and CLI; only the upstream model and MCP service are local fixtures. */
describe.skipIf(!codex)("daemon Codex dispatch", () => {
  let daemon: Daemon;
  let home: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let requests = 0;
  let modelSawSkill = false;
  let holdResponse: Promise<void> | undefined;
  let onModelRequest: ((body: string) => void) | undefined;
  const modelInputs: string[] = [];
  const mcpHeaders: Array<string | null> = [];
  const secret = "synthetic-mcp-credential-example";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "codex-daemon-e2e-"));
    const plugin = join(home, "plugin-example");
    const skill = join(plugin, "skills", "example-codex-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: example-codex-skill\ndescription: Example skill for the Codex dispatch test.\n---\nRespond with a short greeting.\n",
    );
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/mcp" && req.method === "POST") {
          mcpHeaders.push(req.headers.get("authorization"));
          const message = await req.json();
          if (!("id" in message)) return new Response(null, { status: 202 });
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1.0.0" },
                }
              : message.method === "tools/list"
                ? { tools: [] }
                : {};
          return Response.json({ jsonrpc: "2.0", id: message.id, result });
        }
        if (path === "/v1/responses" && req.method === "POST") {
          const body = await req.text();
          modelSawSkill ||= body.includes("example-codex-skill");
          modelInputs.push(body);
          onModelRequest?.(body);
          const hold = holdResponse;
          if (hold) await hold;
          requests++;
          const item = {
            id: `message_example_${requests}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Codex fixture response",
                annotations: [],
              },
            ],
          };
          const response = {
            id: `response_example_${requests}`,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            output: [item],
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
          const events = [
            {
              type: "response.created",
              response: { ...response, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            },
            {
              type: "response.content_part.added",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "Codex fixture response",
            },
            {
              type: "response.output_text.done",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text: "Codex fixture response",
            },
            {
              type: "response.content_part.done",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: item.content[0],
            },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ];
          return new Response(
            events
              .map(
                (event, sequence_number) =>
                  `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ data: [] });
      },
    });
    daemon = await startDaemon({
      HARNESS_RUNNER_CMD: JSON.stringify([
        process.execPath,
        join(import.meta.dir, "../../harness-runner/main.ts"),
      ]),
      CODEX_PATH: codex ?? "codex",
      CODEX_HOME: home,
      CODEX_MODEL: "gpt-6.1-sol",
      CODEX_API_KEY: "synthetic-api-key-example",
      OPENAI_BASE_URL: `http://localhost:${upstream.port}/v1`,
      STUDIO_CODEX_AUTH_JSON: "",
      CLAUDE_CODE_PLUGIN_DIRS: plugin,
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopDaemon(daemon);
    upstream?.stop(true);
    if (home) await rm(home, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  function envelope(runId: string, threadId: string) {
    return {
      harnessId: "codex",
      runId: runId,
      input: {
        threadId: threadId,
        userMessage: {
          id: `message_${runId}`,
          role: "user",
          parts: [{ type: "text", text: "Say hello." }],
        },
        harness: {},
        workspace: { cwd: "/repo", branch: null },
        models: {
          thinking: {
            id: "gpt-6.1-sol",
            title: "Codex",
            credentialId: "key_example",
          },
        },
        mcp: {
          url: `http://localhost:${upstream.port}/mcp`,
          headers: { Authorization: `Bearer ${secret}` },
          expiresAt: Date.now() + 3600000,
        },
        mode: "default",
        temperature: 0,
        liveMessages: false,
        toolApprovalLevel: "auto",
        user: { id: "user_example", email: "user@example.com" },
        organizationId: "org_example",
        agent: { id: "agent_example" },
      },
    };
  }

  test("streams two turns, resumes the session, counts usage per turn, and excludes MCP credentials from persisted transcripts", async () => {
    let session: string | undefined;
    for (let turn = 0; turn < 2; turn++) {
      const res = await fetch(url(daemon, "/_sandbox/dispatch"), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(
          envelope(`run_codex_example_${turn}`, "thread_codex_example"),
        ),
        signal: AbortSignal.timeout(30000),
      });
      expect(res.ok).toBeTrue();
      const body = await res.text();
      const frames = body
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      expect(frames.some((frame) => frame.error)).toBeFalse();
      expect(frames.at(-1).done).toBeTrue();
      const chunks = frames.flatMap((frame) => frame.chunks);
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === "text-delta" &&
            chunk.delta === "Codex fixture response",
        ),
      ).toBeTrue();
      expect(chunks.find((chunk) => chunk.type === "finish")).toMatchObject({
        finishReason: "stop",
        messageMetadata: {
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
      });
      expect(body).not.toContain(secret);
      const current = await readFile(
        join(home, "deco-sessions", "thread_codex_example"),
        "utf8",
      );
      if (session) expect(current).toBe(session);
      session = current;
    }
    expect(requests).toBe(2);
    expect(modelSawSkill).toBeTrue();
    expect(mcpHeaders).toContain(`Bearer ${secret}`);
    const files = await readdir(home, { recursive: true });
    expect(files.some((path) => path.includes(".studio-runtime-"))).toBeFalse();
    const transcripts = files.filter((path) => path.endsWith(".jsonl"));
    expect(transcripts.length).toBeGreaterThan(0);
    for (const path of transcripts)
      expect(await readFile(join(home, path), "utf8")).not.toContain(secret);
  }, 60000);

  test.each([false, true])(
    "steers the active native turn through the daemon, persistent=%s",
    async (persistent) => {
      const runId = `run_steer_example_${persistent}`;
      let release: (() => void) | undefined;
      holdResponse = new Promise<void>((resolve) => {
        release = resolve;
      });
      const modelStarted = new Promise<void>((resolve) => {
        onModelRequest = () => resolve();
      });
      const before = modelInputs.length;
      const body = envelope(runId, `thread_steer_example_${persistent}`);
      body.input.liveMessages = true;
      const response = fetch(url(daemon, "/_sandbox/dispatch"), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          ...body,
          ...(persistent ? { sessionKey: "steer-session-example" } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      }).then(async (res) => {
        expect(res.ok).toBeTrue();
        return res.text();
      });
      void response.catch(() => {});
      try {
        await modelStarted;
        const endpoint = url(daemon, `/_sandbox/runs/${runId}/messages`);
        const message = {
          id: "live_message_example",
          text: "STEER_MARKER_EXAMPLE: focus on tests",
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const delivered = await fetch(endpoint, {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(5000),
          });
          expect(delivered.status).toBe(200);
          expect(await delivered.json()).toEqual({
            delivered: true,
            ...(attempt ? { duplicate: true } : {}),
          });
        }
        release?.();
        const frames = (await response)
          .trim()
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        expect(frames.some((frame) => frame.error)).toBeFalse();
        expect(frames.at(-1).done).toBeTrue();
        const chunks = frames.flatMap((frame) => frame.chunks);
        expect(chunks.filter((chunk) => chunk.type === "start")).toHaveLength(
          1,
        );
        expect(chunks.filter((chunk) => chunk.type === "finish")).toHaveLength(
          1,
        );
        expect(
          chunks.filter((chunk) => chunk.type === "data-live-message"),
        ).toEqual([
          {
            type: "data-live-message",
            id: "live-message-live_message_example",
            data: { messageId: message.id },
          },
        ]);
        expect(
          modelInputs
            .slice(before)
            .some((input) => input.includes(message.text)),
        ).toBeTrue();
        const finish = chunks.find((chunk) => chunk.type === "finish");
        // The first inference was steered before producing a response. Only the completed call is billed.
        expect(finish.messageMetadata.usage.totalTokens).toBe(7);
        expect(
          (
            await fetch(endpoint, {
              method: "POST",
              headers: authHeaders({ "content-type": "application/json" }),
              body: JSON.stringify({
                id: "late_message_example",
                text: "too late",
              }),
            })
          ).status,
        ).toBe(409);
      } finally {
        onModelRequest = undefined;
        holdResponse = undefined;
        release?.();
        await response.catch(() => {});
      }
    },
    30000,
  );
});
