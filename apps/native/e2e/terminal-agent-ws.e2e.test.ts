/**
 * Black-box WebSocket contract for Studio Native's persistent coding-agent
 * terminals. Deterministic CLI fixtures consume the managed Claude, Codex,
 * and OpenCode launch configuration, invoke the authenticated lifecycle hook,
 * and speak through a real PTY. No local-api implementation modules are
 * imported here.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "@decocms/shared/std";
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  authHeaders,
  describeEmbeddedLocalApi,
  HOOK_TIMEOUT_MS,
  type LocalApi,
  startEmbeddedLocalApi,
  stopLocalApi,
  url,
} from "./helpers";
import { computeHandle, repoDirFor } from "./sandbox-handle";

const ORG = "terminal-ws-org";
const VIRTUAL_MCP_ID = "terminal-ws-agent";
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/interactive-agent.mjs", import.meta.url),
);
const FRAME_TIMEOUT_MS = 15_000;
const PROVIDERS = ["claude-code", "codex", "opencode"] as const;
const FIXTURE_BRANCH = "terminal-e2e";
const CLAUDE_RECOVERY_BRANCH = "terminal-e2e-claude-recovery";
const CLAUDE_RECOVERY_THREAD_ID = "terminal-claude-recovery";
const CLAUDE_STALE_SESSION_ID = "studio-e2e-claude-code-session";
const CLAUDE_RECOVERED_SESSION_ID = "studio-e2e-claude-code-recovered-session";

type HarnessId = (typeof PROVIDERS)[number];

interface ServerFrame {
  type: string;
  sessionId?: string;
  harnessId?: string;
  physicalState?: string;
  logicalState?: string;
  threadStatus?: string;
  requestId?: string;
  dataBase64?: string;
  expected?: boolean;
  code?: string;
  message?: string;
}

interface LaunchRecord {
  kind: "interactive";
  provider: HarnessId;
  args: string[];
  resumeId: string | null;
  cwd: string;
  pid: number;
  simulatedMissingResume?: true;
  managedLaunch: {
    nativeGuardrails: true;
    virtualMcpInstructions: true;
    mcpServerNames: ["cms"];
    scopedMcpAuthorization: true;
    workspaceTrustSuppressed: true | null;
  };
}

interface TitleRecord {
  kind: "title";
  provider: HarnessId;
  promptViaStdin: true;
  integrationsDisabled: true;
  managedCodexHome: boolean | null;
}

interface TerminalClient {
  socket: WebSocket;
  frames: ServerFrame[];
  output: { value: string };
  failure: { value: string | null };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "terminal-agent-git-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", FIXTURE_BRANCH, workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workDir, "README.md"), "terminal agent fixture\n");
  git(workDir, ["add", "README.md"]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", FIXTURE_BRANCH]);
  git(workDir, ["branch", CLAUDE_RECOVERY_BRANCH]);
  git(workDir, ["push", "-q", "origin", CLAUDE_RECOVERY_BRANCH]);
  git(bareDir, ["symbolic-ref", "HEAD", `refs/heads/${FIXTURE_BRANCH}`]);
  return { root, bareDir };
}

async function connectTerminal(
  api: LocalApi,
  threadId: string,
  privateHeaders: Record<string, string>,
): Promise<TerminalClient> {
  const target = url(
    api,
    `/api/${ORG}/threads/${threadId}/terminal/ws`,
  ).replace("http://", "ws://");
  // Bun's client supports an HTTP-header options object. DOM's portable
  // WebSocket type exposes only subprotocols, so keep the runtime extension
  // isolated at this black-box transport seam.
  const socket = new WebSocket(target, {
    headers: privateHeaders,
  } as unknown as string[]);
  const frames: ServerFrame[] = [];
  const output = { value: "" };
  const failure = { value: null as string | null };
  socket.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      frames.push(frame);
      if (frame.type === "output" && frame.dataBase64) {
        output.value += Buffer.from(frame.dataBase64, "base64").toString(
          "utf8",
        );
      }
    } catch (error) {
      failure.value = `invalid server frame: ${String(error)}`;
    }
  });
  socket.addEventListener("error", () => {
    failure.value = "terminal WebSocket failed";
  });

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("terminal WebSocket failed to open")),
        { once: true },
      );
    }),
    sleep(FRAME_TIMEOUT_MS).then(() => {
      throw new Error("terminal WebSocket did not open before the deadline");
    }),
  ]);

  return { socket, frames, output, failure };
}

function terminalOutputFrames(client: TerminalClient): string[] {
  return client.frames.flatMap((frame) =>
    frame.type === "output" && frame.dataBase64
      ? [Buffer.from(frame.dataBase64, "base64").toString("utf8")]
      : [],
  );
}

function normalizeTerminalOutput(output: string): string {
  const escape = String.fromCharCode(27);
  const twoByteEscape = new RegExp(`${escape}[78]`, "g");
  const charsetEscape = new RegExp(`${escape}\\([0-2A-Za-z]`, "g");
  const csiEscape = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");
  return output
    .replace(twoByteEscape, "")
    .replace(charsetEscape, "")
    .replace(csiEscape, (sequence) => (sequence.endsWith("G") ? " " : ""))
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function expectMissingClaudeResumeDiagnosticHidden(
  client: TerminalClient,
  staleSessionId: string,
): void {
  const chunks = terminalOutputFrames(client);
  for (const chunk of chunks) {
    expect(chunk).not.toContain(staleSessionId);
  }
  const combined = chunks.join("");
  expect(combined).not.toContain(staleSessionId);
  expect(normalizeTerminalOutput(combined)).not.toContain(
    `No conversation found with session ID: ${staleSessionId}`,
  );
  expect(normalizeTerminalOutput(client.output.value)).not.toContain(
    "No conversation found with session ID:",
  );
}

async function waitForFrame(
  client: TerminalClient,
  predicate: (frame: ServerFrame) => boolean,
  description: string,
): Promise<ServerFrame> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = client.frames.find(predicate);
    if (match) return match;
    if (client.failure.value) throw new Error(client.failure.value);
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for ${description}; frames=${JSON.stringify(client.frames)} output=${JSON.stringify(client.output.value)}`,
  );
}

async function waitForOutput(
  client: TerminalClient,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (client.output.value.includes(expected)) return;
    if (client.failure.value) throw new Error(client.failure.value);
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for terminal output ${JSON.stringify(expected)}; output=${JSON.stringify(client.output.value)} frames=${JSON.stringify(client.frames)}`,
  );
}

async function terminateAndWaitForExit(
  client: TerminalClient,
  launch: LaunchRecord,
): Promise<ServerFrame> {
  const startedAt = Date.now();
  client.socket.send(JSON.stringify({ type: "terminate" }));
  const terminalFrame = await waitForFrame(
    client,
    (frame) =>
      frame.type === "exit" ||
      (frame.type === "error" && frame.code === "invalid_control"),
    "explicit termination result",
  );
  if (terminalFrame.type === "error") {
    throw new Error(
      `explicit terminate failed after ${Date.now() - startedAt}ms: ${terminalFrame.message}; ${processDiagnostics(launch.pid)}`,
    );
  }
  return terminalFrame;
}

function processDiagnostics(pid: number): string {
  const columns = "pid=,ppid=,pgid=,tpgid=,tty=,stat=,command=";
  const process = spawnSync("/bin/ps", ["-o", columns, "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  const tty = spawnSync("/bin/ps", ["-o", "tty=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  const ttyProcesses = tty
    ? spawnSync("/bin/ps", ["-axo", columns], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line.includes(` ${tty} `))
        .join(" | ")
    : "";
  return `fixture=${process || "not found"}; ttyProcesses=${ttyProcesses || "none"}`;
}

function processIsAlive(pid: number): boolean {
  return (
    spawnSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim() === String(pid)
  );
}

async function waitForProviderCheckpoint(
  api: LocalApi,
  threadId: string,
  privateHeaders: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(
      url(api, `/api/${ORG}/threads/${threadId}/terminal`),
      { headers: privateHeaders },
    );
    if (response.status === 200) {
      const metadata = (await response.json()) as {
        providerSessionAvailable?: boolean;
      };
      if (metadata.providerSessionAvailable === true) return;
    }
    await sleep(20);
  }
  throw new Error("provider session checkpoint was not persisted");
}

async function waitForThreadTitle(
  api: LocalApi,
  threadId: string,
  privateHeaders: Record<string, string>,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(
      url(api, `/api/${ORG}/tools/COLLECTION_THREADS_GET`),
      {
        method: "POST",
        headers: {
          ...privateHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: threadId }),
      },
    );
    if (response.status === 200) {
      const body = (await response.json()) as {
        item?: { title?: string };
      };
      if (body.item?.title === expected) return;
    }
    await sleep(20);
  }
  throw new Error(`thread title did not become ${JSON.stringify(expected)}`);
}

function launchRecords(
  path: string,
  provider: HarnessId,
  cwd?: string,
): LaunchRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LaunchRecord)
    .filter(
      (record) =>
        record.kind === "interactive" &&
        record.provider === provider &&
        (cwd === undefined || record.cwd === cwd),
    );
}

async function waitForLaunchRecords(
  path: string,
  provider: HarnessId,
  count: number,
  cwd?: string,
): Promise<LaunchRecord[]> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const records = launchRecords(path, provider, cwd);
    if (records.length >= count) return records;
    await sleep(20);
  }
  throw new Error(`did not observe ${count} ${provider} fixture launches`);
}

async function waitForTitleRecord(
  path: string,
  provider: HarnessId,
): Promise<TitleRecord> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const record = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LaunchRecord | TitleRecord)
        .find(
          (candidate): candidate is TitleRecord =>
            candidate.kind === "title" && candidate.provider === provider,
        );
      if (record) return record;
    }
    await sleep(20);
  }
  throw new Error(`did not observe isolated ${provider} title generation`);
}

function titleRecords(path: string, provider: HarnessId): TitleRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LaunchRecord | TitleRecord)
    .filter(
      (record): record is TitleRecord =>
        record.kind === "title" && record.provider === provider,
    );
}

describeEmbeddedLocalApi("native terminal-agent WebSocket lifecycle", () => {
  let api: LocalApi | null = null;
  let upstream: ReturnType<typeof startAuthenticatedUpstream> | null = null;
  let claudeConfigDir: string | null = null;
  let gitFixture: ReturnType<typeof setupFixtureRepo> | null = null;
  let privateHeaders: Record<string, string> = {};
  const launchLog = join(
    tmpdir(),
    `studio-terminal-agent-${process.pid}-${randomUUID()}.jsonl`,
  );
  const missingClaudeResumeSentinel = join(
    tmpdir(),
    `studio-terminal-agent-missing-resume-${process.pid}-${randomUUID()}`,
  );

  beforeAll(async () => {
    gitFixture = setupFixtureRepo();
    claudeConfigDir = mkdtempSync(join(tmpdir(), "studio-terminal-claude-"));
    writeFileSync(
      join(claudeConfigDir, ".claude.json"),
      `${JSON.stringify(
        {
          studioE2eSentinel: { preserve: true },
          projects: {
            "/studio-e2e/unrelated": {
              allowedTools: ["Read"],
              custom: "keep",
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    upstream = startAuthenticatedUpstream({
      virtualMcps: {
        [VIRTUAL_MCP_ID]: {
          id: VIRTUAL_MCP_ID,
          title: "Terminal WS agent",
          metadata: {
            instructions: "Reply through the deterministic terminal fixture.",
            githubRepo: { url: gitFixture.bareDir },
          },
        },
      },
    });
    const fixturePrefix = (provider: HarnessId) =>
      JSON.stringify([
        process.execPath,
        FIXTURE_PATH,
        "--stub-provider",
        provider,
      ]);
    api = await startEmbeddedLocalApi({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_CLAUDE_BIN: fixturePrefix("claude-code"),
      LOCAL_API_CODEX_BIN: fixturePrefix("codex"),
      LOCAL_API_OPENCODE_BIN: fixturePrefix("opencode"),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      STUDIO_OPENCODE_SESSION_ID: "ambient-stale-session",
      STUDIO_TERMINAL_E2E_LOG: launchLog,
      STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_BRANCH: CLAUDE_RECOVERY_BRANCH,
      STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_SENTINEL:
        missingClaudeResumeSentinel,
    });
    const controlOrigin = `http://127.0.0.1:${api.port}`;
    const bootstrap = await fetch(url(api, "/_local/session/bootstrap"), {
      method: "POST",
      headers: authHeaders({ Origin: controlOrigin }),
    });
    expect(bootstrap.status).toBe(204);
    const setCookie = bootstrap.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie) throw new Error("embedded bootstrap did not return a cookie");
    privateHeaders = { Cookie: cookie, Origin: controlOrigin };
    await signInAndCompleteSession(api, privateHeaders);

    for (const provider of PROVIDERS) {
      const created = await fetch(
        url(api, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
        {
          method: "POST",
          headers: {
            ...privateHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: {
              id: `terminal-${provider}`,
              title: "New chat",
              virtual_mcp_id: VIRTUAL_MCP_ID,
              branch: FIXTURE_BRANCH,
            },
          }),
        },
      );
      expect(created.status).toBe(200);
    }

    const recoveryThread = await fetch(
      url(api, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: {
          ...privateHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            id: CLAUDE_RECOVERY_THREAD_ID,
            title: "New chat",
            virtual_mcp_id: VIRTUAL_MCP_ID,
            branch: CLAUDE_RECOVERY_BRANCH,
          },
        }),
      },
    );
    expect(recoveryThread.status).toBe(200);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
    upstream?.server.stop(true);
    rmSync(launchLog, { force: true });
    rmSync(missingClaudeResumeSentinel, { force: true });
    if (claudeConfigDir) {
      rmSync(claudeConfigDir, { recursive: true, force: true });
    }
    if (gitFixture) {
      rmSync(gitFixture.root, { recursive: true, force: true });
    }
  }, HOOK_TIMEOUT_MS);

  for (const provider of PROVIDERS) {
    it(
      `${provider} launches, checkpoints its lifecycle, and resumes after termination`,
      async () => {
        if (!api) throw new Error("local-api did not start");
        if (!gitFixture) throw new Error("git fixture was not initialized");
        const threadId = `terminal-${provider}`;
        const prompt = `hello-from-${provider}`;
        const requestId = `prompt-${provider}`;
        const first = await connectTerminal(api, threadId, privateHeaders);

        try {
          first.socket.send(
            JSON.stringify({
              type: "start",
              harnessId: provider,
              rows: 30,
              cols: 100,
              initialPrompt: prompt,
              requestId,
            }),
          );
          const ready = await waitForFrame(
            first,
            (frame) => frame.type === "ready",
            "fresh ready frame",
          );
          expect(ready.harnessId).toBe(provider);
          expect(ready.physicalState).toBe("running");
          expect(typeof ready.sessionId).toBe("string");

          await waitForOutput(
            first,
            `STUB_READY:${provider}:studio-e2e-${provider}-session`,
          );
          await waitForFrame(
            first,
            (frame) =>
              frame.type === "prompt_accepted" && frame.requestId === requestId,
            "correlated prompt acceptance",
          );
          await waitForOutput(first, `STUB_REPLY:${provider}:${prompt}`);
          const waitingForInput =
            provider === "opencode"
              ? await waitForFrame(
                  first,
                  (frame) =>
                    frame.type === "state" &&
                    frame.logicalState === "waiting_input",
                  "OpenCode permission or question lifecycle state",
                )
              : null;
          const completed = await waitForFrame(
            first,
            (frame) =>
              frame.type === "state" &&
              frame.logicalState === "completed" &&
              frame.threadStatus === "completed",
            "completed lifecycle state",
          );
          if (waitingForInput) {
            expect(first.frames.indexOf(completed)).toBeGreaterThan(
              first.frames.indexOf(waitingForInput),
            );
          }
          await waitForProviderCheckpoint(api, threadId, privateHeaders);
          if (provider === "opencode") {
            await waitForThreadTitle(
              api,
              threadId,
              privateHeaders,
              "Stub opencode chat",
            );
            expect(titleRecords(launchLog, provider)).toEqual([]);
          } else {
            expect(await waitForTitleRecord(launchLog, provider)).toEqual({
              kind: "title",
              provider,
              promptViaStdin: true,
              integrationsDisabled: true,
              managedCodexHome: provider === "codex" ? true : null,
            });
          }
          const expectedCwd = realpathSync(
            repoDirFor(
              api.workdir,
              computeHandle(gitFixture.bareDir, FIXTURE_BRANCH),
            ),
          );

          const firstLaunches = await waitForLaunchRecords(
            launchLog,
            provider,
            1,
            expectedCwd,
          );
          expect(firstLaunches[0]?.resumeId).toBeNull();
          expect(firstLaunches[0]?.managedLaunch).toEqual({
            nativeGuardrails: true,
            virtualMcpInstructions: true,
            mcpServerNames: ["cms"],
            scopedMcpAuthorization: true,
            workspaceTrustSuppressed: provider === "opencode" ? null : true,
          });
          if (provider === "opencode") {
            expect(firstLaunches[0]?.args[0]).toBe("--agent");
            expect(firstLaunches[0]?.args[1]).toMatch(/^studio-native-.+/);
            expect(firstLaunches[0]?.args).not.toContain("--model");
          }
          expect(firstLaunches[0]?.cwd).toBe(expectedCwd);
          expect(existsSync(join(api.workdir, ".decocms", "rclone", ORG))).toBe(
            false,
          );

          const firstExit = await terminateAndWaitForExit(
            first,
            firstLaunches[0]!,
          );
          expect(firstExit.expected).toBe(true);
        } finally {
          first.socket.close();
        }

        const resumed = await connectTerminal(api, threadId, privateHeaders);
        try {
          resumed.socket.send(
            JSON.stringify({
              type: "start",
              harnessId: provider,
              rows: 30,
              cols: 100,
            }),
          );
          const ready = await waitForFrame(
            resumed,
            (frame) => frame.type === "ready",
            "resumed ready frame",
          );
          expect(ready.harnessId).toBe(provider);
          expect(ready.physicalState).toBe("running");
          await waitForOutput(
            resumed,
            `STUB_READY:${provider}:studio-e2e-${provider}-session`,
          );

          const expectedCwd = realpathSync(
            repoDirFor(
              api.workdir,
              computeHandle(gitFixture.bareDir, FIXTURE_BRANCH),
            ),
          );
          const launches = await waitForLaunchRecords(
            launchLog,
            provider,
            2,
            expectedCwd,
          );
          expect(launches[1]?.resumeId).toBe(`studio-e2e-${provider}-session`);
          expect(launches[1]?.managedLaunch).toEqual({
            nativeGuardrails: true,
            virtualMcpInstructions: true,
            mcpServerNames: ["cms"],
            scopedMcpAuthorization: true,
            workspaceTrustSuppressed: provider === "opencode" ? null : true,
          });
          if (provider === "claude-code") {
            expect(launches[1]?.args).toContain("--resume");
          } else if (provider === "codex") {
            expect(launches[1]?.args).toContain("resume");
          } else {
            expect(launches[1]?.args[0]).toBe("--agent");
            expect(launches[1]?.args[1]).toMatch(/^studio-native-.+/);
            expect(launches[1]?.args.slice(2)).toEqual([
              "--session",
              `studio-e2e-${provider}-session`,
            ]);
            expect(launches[1]?.args).not.toContain("--model");
          }

          const resumedExit = await terminateAndWaitForExit(
            resumed,
            launches[1]!,
          );
          expect(resumedExit.expected).toBe(true);
        } finally {
          resumed.socket.close();
        }
      },
      HOOK_TIMEOUT_MS,
    );
  }

  it(
    "Claude falls back from a missing resume to a fresh process on the same WebSocket",
    async () => {
      if (!api) throw new Error("local-api did not start");
      if (!gitFixture) throw new Error("git fixture was not initialized");
      const provider = "claude-code";
      const seedPrompt = "seed-claude-recovery";
      const seedRequestId = "seed-claude-recovery-request";
      const seed = await connectTerminal(
        api,
        CLAUDE_RECOVERY_THREAD_ID,
        privateHeaders,
      );

      let recoveryCwd: string;
      try {
        seed.socket.send(
          JSON.stringify({
            type: "start",
            harnessId: provider,
            rows: 30,
            cols: 100,
            initialPrompt: seedPrompt,
            requestId: seedRequestId,
          }),
        );
        await waitForFrame(
          seed,
          (frame) => frame.type === "ready",
          "Claude recovery seed ready frame",
        );
        await waitForOutput(
          seed,
          `STUB_READY:${provider}:${CLAUDE_STALE_SESSION_ID}`,
        );
        await waitForFrame(
          seed,
          (frame) =>
            frame.type === "prompt_accepted" &&
            frame.requestId === seedRequestId,
          "Claude recovery seed prompt acceptance",
        );
        await waitForOutput(seed, `STUB_REPLY:${provider}:${seedPrompt}`);
        await waitForFrame(
          seed,
          (frame) =>
            frame.type === "state" &&
            frame.logicalState === "completed" &&
            frame.threadStatus === "completed",
          "Claude recovery seed completion",
        );
        await waitForProviderCheckpoint(
          api,
          CLAUDE_RECOVERY_THREAD_ID,
          privateHeaders,
        );

        recoveryCwd = realpathSync(
          repoDirFor(
            api.workdir,
            computeHandle(gitFixture.bareDir, CLAUDE_RECOVERY_BRANCH),
          ),
        );
        const seedLaunches = await waitForLaunchRecords(
          launchLog,
          provider,
          1,
          recoveryCwd,
        );
        expect(seedLaunches).toHaveLength(1);
        expect(seedLaunches[0]?.resumeId).toBeNull();
        expect(seedLaunches[0]?.simulatedMissingResume).toBeUndefined();
        const seedExit = await terminateAndWaitForExit(seed, seedLaunches[0]!);
        expect(seedExit.expected).toBe(true);
        expect(processIsAlive(seedLaunches[0]!.pid)).toBe(false);
      } finally {
        seed.socket.close();
      }

      const recovered = await connectTerminal(
        api,
        CLAUDE_RECOVERY_THREAD_ID,
        privateHeaders,
      );
      let recoveredLaunch: LaunchRecord;
      try {
        recovered.socket.send(
          JSON.stringify({
            type: "start",
            harnessId: provider,
            rows: 30,
            cols: 100,
          }),
        );
        const ready = await waitForFrame(
          recovered,
          (frame) => frame.type === "ready",
          "fresh Claude ready frame after missing resume",
        );
        expect(ready.harnessId).toBe(provider);
        expect(ready.physicalState).toBe("running");
        await waitForOutput(
          recovered,
          `STUB_READY:${provider}:${CLAUDE_RECOVERED_SESSION_ID}`,
        );

        const launches = await waitForLaunchRecords(
          launchLog,
          provider,
          3,
          recoveryCwd,
        );
        expect(launches).toHaveLength(3);
        expect(launches.map((launch) => launch.resumeId)).toEqual([
          null,
          CLAUDE_STALE_SESSION_ID,
          null,
        ]);
        expect(launches[1]?.simulatedMissingResume).toBe(true);
        expect(launches[1]?.args).toContain("--resume");
        expect(launches[2]?.simulatedMissingResume).toBeUndefined();
        expect(launches[2]?.args).not.toContain("--resume");
        recoveredLaunch = launches[2]!;
        expect(new Set(launches.map((launch) => launch.pid)).size).toBe(3);
        expect(processIsAlive(launches[0]!.pid)).toBe(false);
        expect(processIsAlive(launches[1]!.pid)).toBe(false);
        expect(processIsAlive(launches[2]!.pid)).toBe(true);
        expect(
          recovered.frames.filter((frame) => frame.type === "ready"),
        ).toHaveLength(1);
        expect(recovered.frames.some((frame) => frame.type === "exit")).toBe(
          false,
        );
        expectMissingClaudeResumeDiagnosticHidden(
          recovered,
          CLAUDE_STALE_SESSION_ID,
        );

        const recoveryPrompt = "prompt-after-claude-recovery";
        const recoveryRequestId = "prompt-after-claude-recovery-request";
        recovered.socket.send(
          JSON.stringify({
            type: "submit_prompt",
            text: recoveryPrompt,
            requestId: recoveryRequestId,
          }),
        );
        await waitForFrame(
          recovered,
          (frame) =>
            frame.type === "prompt_accepted" &&
            frame.requestId === recoveryRequestId,
          "prompt acceptance after Claude recovery",
        );
        const expectedReply = `STUB_REPLY:${provider}:${recoveryPrompt}`;
        await waitForOutput(recovered, expectedReply);
        expect(recovered.output.value.split(expectedReply)).toHaveLength(2);
        await waitForOutput(recovered, `STUB_COMPLETED:${provider}`);
        await waitForFrame(
          recovered,
          (frame) =>
            frame.type === "state" &&
            frame.logicalState === "completed" &&
            frame.threadStatus === "completed",
          "Claude completion after fresh recovery",
        );
        await waitForProviderCheckpoint(
          api,
          CLAUDE_RECOVERY_THREAD_ID,
          privateHeaders,
        );
        expect(
          recovered.frames.filter(
            (frame) =>
              frame.type === "prompt_accepted" &&
              frame.requestId === recoveryRequestId,
          ),
        ).toHaveLength(1);
        expectMissingClaudeResumeDiagnosticHidden(
          recovered,
          CLAUDE_STALE_SESSION_ID,
        );

        const recoveredExit = await terminateAndWaitForExit(
          recovered,
          recoveredLaunch,
        );
        expect(recoveredExit.expected).toBe(true);
      } finally {
        recovered.socket.close();
      }

      expect(processIsAlive(recoveredLaunch.pid)).toBe(false);
      const resumed = await connectTerminal(
        api,
        CLAUDE_RECOVERY_THREAD_ID,
        privateHeaders,
      );
      try {
        resumed.socket.send(
          JSON.stringify({
            type: "start",
            harnessId: provider,
            rows: 30,
            cols: 100,
          }),
        );
        const ready = await waitForFrame(
          resumed,
          (frame) => frame.type === "ready",
          "Claude ready frame after recovered checkpoint",
        );
        expect(ready.harnessId).toBe(provider);
        expect(ready.physicalState).toBe("running");
        await waitForOutput(
          resumed,
          `STUB_READY:${provider}:${CLAUDE_RECOVERED_SESSION_ID}`,
        );

        const launches = await waitForLaunchRecords(
          launchLog,
          provider,
          4,
          recoveryCwd,
        );
        expect(launches).toHaveLength(4);
        expect(launches.map((launch) => launch.resumeId)).toEqual([
          null,
          CLAUDE_STALE_SESSION_ID,
          null,
          CLAUDE_RECOVERED_SESSION_ID,
        ]);
        expect(launches[3]?.simulatedMissingResume).toBeUndefined();
        const resumeIndex = launches[3]!.args.indexOf("--resume");
        expect(launches[3]!.args.slice(resumeIndex, resumeIndex + 2)).toEqual([
          "--resume",
          CLAUDE_RECOVERED_SESSION_ID,
        ]);
        expect(processIsAlive(launches[3]!.pid)).toBe(true);
        expectMissingClaudeResumeDiagnosticHidden(
          resumed,
          CLAUDE_STALE_SESSION_ID,
        );

        const resumedExit = await terminateAndWaitForExit(
          resumed,
          launches[3]!,
        );
        expect(resumedExit.expected).toBe(true);
      } finally {
        resumed.socket.close();
      }
    },
    HOOK_TIMEOUT_MS,
  );
});
