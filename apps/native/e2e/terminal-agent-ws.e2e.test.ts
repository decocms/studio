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
import { dirname, join } from "node:path";
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
import { hasCliFlag } from "./fixtures/cli-flags.mjs";

const ORG = "terminal-ws-org";
const VIRTUAL_MCP_ID = "terminal-ws-agent";
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/interactive-agent.mjs", import.meta.url),
);
const FRAME_TIMEOUT_MS = 15_000;
const PROVIDERS = ["claude-code", "codex", "opencode"] as const;
const FIXTURE_DEFAULT_BRANCH = "main";
const FIXTURE_BRANCH = "terminal-e2e";
const CLAUDE_RECOVERY_BRANCH = "terminal-e2e-claude-recovery";
const CLAUDE_RECOVERY_THREAD_ID = "terminal-claude-recovery";
const CLAUDE_STALE_SESSION_ID = "studio-e2e-claude-code-session";
const CLAUDE_RECOVERED_SESSION_ID = "studio-e2e-claude-code-recovered-session";
const CODEX_RESTART_BRANCH = "terminal-e2e-codex-restart";
const CODEX_RESTART_THREAD_ID = "terminal-codex-restart";
const CODEX_RESTART_SESSION_ID = "studio-e2e-codex-restart-session";
const CODEX_PREFLIGHT_FENCE_BRANCH = "terminal-e2e-codex-preflight-fence";
const CODEX_PREFLIGHT_FENCE_THREAD_ID = "terminal-codex-preflight-fence";
const CODEX_HOOK_RPC_EVENTS = [
  "sessionStart",
  "userPromptSubmit",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "subagentStart",
  "subagentStop",
  "stop",
] as const;
const CODEX_PREFLIGHT_SECRET_ENV = [
  "DECOCMS_MCP_URL",
  "DECOCMS_MCP_AUTHORIZATION",
  "STUDIO_AGENT_HOOK_URL",
  "STUDIO_AGENT_HOOK_TOKEN",
  "OPENCODE_CONFIG_CONTENT",
  "STUDIO_OPENCODE_SESSION_ID",
] as const;

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
  heldResumeHook?: true;
  managedLaunch: {
    nativeGuardrails: true;
    virtualMcpInstructions: true;
    mcpServerNames: ["cms"];
    scopedMcpAuthorization: true;
    workspaceTrustSuppressed: true | null;
    codexYoloMode?: true;
    codexHookTrustBypassAbsent?: true;
    codexTooltipsDisabled?: true;
    codexHookTrustPreflightSequence?: number;
  };
}

interface TitleRecord {
  kind: "title";
  provider: HarnessId;
  promptViaStdin: true;
  integrationsDisabled: true;
  managedCodexHome: boolean | null;
}

interface CodexHookTrustPreflightRecord {
  kind: "codex_hook_trust_preflight";
  provider: "codex";
  args: string[];
  cwd: string;
  hooksPath: string;
  configPath: string;
  trustStatePath: string;
  preflightSequence: number;
  wroteTrust: boolean;
  initializeResult: {
    userAgent: string;
    codexHome: string;
  };
  batchWriteResult: {
    status: "ok";
    version: string;
    filePath: string;
  } | null;
  requests: string[];
  secretEnvironmentAbsent: string[];
  managedHooks: Array<{
    eventName: string;
    handlerType: "command";
    matcher: null;
    command: string;
    timeoutSec: 3;
    source: "user";
    sourcePath: string;
    pluginId: null;
    isManaged: false;
    key: string;
    currentHash: string;
    initialTrustStatus: "untrusted" | "trusted";
    verifiedTrustStatus: "trusted";
  }>;
  decoyKeys: string[];
  batchWrite: {
    edits: [
      {
        keyPath: "hooks.state";
        value: Record<string, { trusted_hash: string }>;
        mergeStrategy: "upsert";
      },
    ];
    filePath: null;
    expectedVersion: null;
    reloadUserConfig: true;
  } | null;
  listCwds: [string[]] | [string[], string[]];
  persistedTrustedHooks: Record<string, string>;
}

interface CodexPreflightFenceSentinel {
  pid: number;
  cwd: string;
}

type LaunchLogRecord =
  | LaunchRecord
  | TitleRecord
  | CodexHookTrustPreflightRecord;

interface TerminalClient {
  socket: WebSocket;
  frames: ServerFrame[];
  output: { value: string };
  failure: { value: string | null };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "terminal-agent-git-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", "-b", FIXTURE_DEFAULT_BRANCH, bareDir]);
  git(root, ["init", "-q", "-b", FIXTURE_DEFAULT_BRANCH, workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workDir, "README.md"), "terminal agent fixture\n");
  git(workDir, ["add", "README.md"]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", FIXTURE_DEFAULT_BRANCH]);
  git(workDir, ["branch", FIXTURE_BRANCH]);
  git(workDir, ["push", "-q", "-u", "origin", FIXTURE_BRANCH]);
  git(workDir, ["branch", CLAUDE_RECOVERY_BRANCH]);
  git(workDir, ["push", "-q", "origin", CLAUDE_RECOVERY_BRANCH]);
  git(workDir, ["branch", CODEX_RESTART_BRANCH]);
  git(workDir, ["push", "-q", "origin", CODEX_RESTART_BRANCH]);
  return { root, bareDir };
}

async function authenticateEmbeddedApi(
  api: LocalApi,
): Promise<Record<string, string>> {
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
  const headers = { Cookie: cookie, Origin: controlOrigin };
  await signInAndCompleteSession(api, headers);
  return headers;
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

async function waitForCodexPreflightFenceSentinel(
  path: string,
): Promise<CodexPreflightFenceSentinel> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const parsed = JSON.parse(
        readFileSync(path, "utf8"),
      ) as Partial<CodexPreflightFenceSentinel>;
      if (
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid ?? 0) > 0 &&
        typeof parsed.cwd === "string" &&
        parsed.cwd.length > 0
      ) {
        return { pid: parsed.pid!, cwd: parsed.cwd };
      }
      throw new Error("Codex preflight account-fence sentinel is invalid");
    }
    await sleep(20);
  }
  throw new Error("Codex preflight did not enter its account fence");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(20);
  }
  throw new Error(`process ${pid} remained alive after its cleanup fence`);
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
    .map((line) => JSON.parse(line) as LaunchLogRecord)
    .filter(
      (record): record is LaunchRecord =>
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
        .map((line) => JSON.parse(line) as LaunchLogRecord)
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
    .map((line) => JSON.parse(line) as LaunchLogRecord)
    .filter(
      (record): record is TitleRecord =>
        record.kind === "title" && record.provider === provider,
    );
}

function codexHookTrustPreflightRecords(
  path: string,
  cwd?: string,
): CodexHookTrustPreflightRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LaunchLogRecord)
    .filter(
      (record): record is CodexHookTrustPreflightRecord =>
        record.kind === "codex_hook_trust_preflight" &&
        (cwd === undefined || record.cwd === cwd),
    );
}

async function waitForCodexHookTrustPreflightRecords(
  path: string,
  count: number,
  cwd?: string,
): Promise<CodexHookTrustPreflightRecord[]> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const records = codexHookTrustPreflightRecords(path, cwd);
    if (records.length >= count) return records;
    await sleep(20);
  }
  throw new Error(`did not observe ${count} Codex hook trust preflights`);
}

function expectCodexInteractiveLaunch(
  record: LaunchRecord,
  expectedPreflightSequence: number,
): void {
  expect(
    record.args.filter(
      (argument) => argument === "--dangerously-bypass-approvals-and-sandbox",
    ),
  ).toHaveLength(1);
  expect(record.args).not.toContain("--sandbox");
  expect(record.args).not.toContain("--ask-for-approval");
  expect(record.args).not.toContain("--dangerously-bypass-hook-trust");
  expect(record.managedLaunch.codexYoloMode).toBe(true);
  expect(record.managedLaunch.codexHookTrustBypassAbsent).toBe(true);
  expect(record.managedLaunch.codexTooltipsDisabled).toBe(true);
  expect(record.managedLaunch.codexHookTrustPreflightSequence).toBe(
    expectedPreflightSequence,
  );
}

function expectCodexHookTrustPreflight(
  record: CodexHookTrustPreflightRecord,
  expectedCwd: string,
  expectedSequence: number,
  expectedWroteTrust: boolean,
): void {
  expect(record.provider).toBe("codex");
  expect(record.args).toEqual([
    "-c",
    "features.hooks=true",
    "app-server",
    "--stdio",
  ]);
  expect(record.cwd).toBe(expectedCwd);
  expect(record.hooksPath).toBe(realpathSync(record.hooksPath));
  expect(record.configPath).toBe(realpathSync(record.configPath));
  expect(record.configPath).toBe(
    join(dirname(record.hooksPath), "config.toml"),
  );
  expect(record.trustStatePath).toBe(realpathSync(record.trustStatePath));
  expect(record.preflightSequence).toBe(expectedSequence);
  expect(record.wroteTrust).toBe(expectedWroteTrust);
  expect(record.initializeResult).toEqual({
    userAgent: "studio-terminal-e2e/1.0.0",
    codexHome: dirname(record.hooksPath),
  });
  expect(record.batchWriteResult).toEqual(
    expectedWroteTrust
      ? {
          status: "ok",
          version: "studio-terminal-e2e-v1",
          filePath: record.configPath,
        }
      : null,
  );
  expect(record.requests).toEqual(
    expectedWroteTrust
      ? [
          "initialize",
          "initialized",
          "hooks/list",
          "config/batchWrite",
          "hooks/list",
        ]
      : ["initialize", "initialized", "hooks/list"],
  );
  expect(record.secretEnvironmentAbsent).toEqual([
    ...CODEX_PREFLIGHT_SECRET_ENV,
  ]);
  expect(record.listCwds).toEqual(
    expectedWroteTrust ? [[expectedCwd], [expectedCwd]] : [[expectedCwd]],
  );
  expect(record.managedHooks.map((hook) => hook.eventName)).toEqual([
    ...CODEX_HOOK_RPC_EVENTS,
  ]);
  expect(record.managedHooks).toHaveLength(CODEX_HOOK_RPC_EVENTS.length);

  const managedKeys = record.managedHooks.map((hook) => hook.key);
  expect(new Set(managedKeys).size).toBe(CODEX_HOOK_RPC_EVENTS.length);
  for (const hook of record.managedHooks) {
    expect(hook).toMatchObject({
      handlerType: "command",
      matcher: null,
      timeoutSec: 3,
      source: "user",
      sourcePath: record.hooksPath,
      pluginId: null,
      isManaged: false,
      initialTrustStatus: expectedWroteTrust ? "untrusted" : "trusted",
      verifiedTrustStatus: "trusted",
    });
    expect(hook.command.length).toBeGreaterThan(0);
    expect(hook.currentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  }

  expect(record.decoyKeys).toEqual([
    "studio-e2e-decoy-project",
    "studio-e2e-decoy-plugin",
    "studio-e2e-decoy-other-user",
  ]);
  for (const decoyKey of record.decoyKeys) {
    expect(managedKeys).not.toContain(decoyKey);
  }
  expect(record.batchWrite).toEqual(
    expectedWroteTrust
      ? {
          edits: [
            {
              keyPath: "hooks.state",
              value: Object.fromEntries(
                record.managedHooks.map((hook) => [
                  hook.key,
                  { trusted_hash: hook.currentHash },
                ]),
              ),
              mergeStrategy: "upsert",
            },
          ],
          filePath: null,
          expectedVersion: null,
          reloadUserConfig: true,
        }
      : null,
  );
  expect(record.persistedTrustedHooks).toEqual(
    Object.fromEntries(
      record.managedHooks.map((hook) => [hook.key, hook.currentHash]),
    ),
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
  const heldCodexResumeHookSentinel = join(
    tmpdir(),
    `studio-terminal-agent-held-codex-resume-${process.pid}-${randomUUID()}`,
  );
  const codexPreflightFenceSentinel = join(
    tmpdir(),
    `studio-terminal-agent-codex-preflight-fence-${process.pid}-${randomUUID()}`,
  );

  const fixtureEnvironment = (): Record<string, string> => {
    if (!upstream) throw new Error("authenticated upstream did not start");
    if (!claudeConfigDir) throw new Error("Claude config was not initialized");
    const fixturePrefix = (provider: HarnessId) =>
      JSON.stringify([
        process.execPath,
        FIXTURE_PATH,
        "--stub-provider",
        provider,
      ]);
    return {
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_CLAUDE_BIN: fixturePrefix("claude-code"),
      LOCAL_API_CODEX_BIN: fixturePrefix("codex"),
      LOCAL_API_OPENCODE_BIN: fixturePrefix("opencode"),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      DECOCMS_MCP_URL: "https://ambient.invalid/mcp",
      DECOCMS_MCP_AUTHORIZATION: "Bearer ambient-mcp-secret",
      STUDIO_AGENT_HOOK_URL: "https://ambient.invalid/hooks",
      STUDIO_AGENT_HOOK_TOKEN: "ambient-hook-secret",
      OPENCODE_CONFIG_CONTENT: '{"ambient":true}',
      STUDIO_OPENCODE_SESSION_ID: "ambient-stale-session",
      STUDIO_TERMINAL_E2E_LOG: launchLog,
      STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_BRANCH: CLAUDE_RECOVERY_BRANCH,
      STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_SENTINEL:
        missingClaudeResumeSentinel,
      STUDIO_TERMINAL_E2E_CODEX_RESUME_HOLD_BRANCH: CODEX_RESTART_BRANCH,
      STUDIO_TERMINAL_E2E_CODEX_RESUME_HOLD_SENTINEL:
        heldCodexResumeHookSentinel,
      STUDIO_TERMINAL_E2E_CODEX_PREFLIGHT_FENCE_BRANCH:
        CODEX_PREFLIGHT_FENCE_BRANCH,
      STUDIO_TERMINAL_E2E_CODEX_PREFLIGHT_FENCE_SENTINEL:
        codexPreflightFenceSentinel,
    };
  };

  beforeAll(async () => {
    gitFixture = setupFixtureRepo();
    expect(git(gitFixture.bareDir, ["symbolic-ref", "--short", "HEAD"])).toBe(
      FIXTURE_DEFAULT_BRANCH,
    );
    expect(FIXTURE_DEFAULT_BRANCH).not.toBe(FIXTURE_BRANCH);
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
    api = await startEmbeddedLocalApi(fixtureEnvironment());
    privateHeaders = await authenticateEmbeddedApi(api);

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

    const restartThread = await fetch(
      url(api, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: {
          ...privateHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            id: CODEX_RESTART_THREAD_ID,
            title: "New chat",
            virtual_mcp_id: VIRTUAL_MCP_ID,
            branch: CODEX_RESTART_BRANCH,
          },
        }),
      },
    );
    expect(restartThread.status).toBe(200);

    const preflightFenceThread = await fetch(
      url(api, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: {
          ...privateHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            id: CODEX_PREFLIGHT_FENCE_THREAD_ID,
            title: "New chat",
            virtual_mcp_id: VIRTUAL_MCP_ID,
            branch: CODEX_PREFLIGHT_FENCE_BRANCH,
          },
        }),
      },
    );
    expect(preflightFenceThread.status).toBe(200);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
    upstream?.server.stop(true);
    rmSync(launchLog, { force: true });
    rmSync(missingClaudeResumeSentinel, { force: true });
    rmSync(heldCodexResumeHookSentinel, { force: true });
    rmSync(codexPreflightFenceSentinel, { force: true });
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
          await waitForThreadTitle(
            api,
            threadId,
            privateHeaders,
            `Stub ${provider} chat`,
          );
          const expectedCwd = realpathSync(
            repoDirFor(
              api.workdir,
              computeHandle(gitFixture.bareDir, FIXTURE_BRANCH),
            ),
          );
          expect(git(expectedCwd, ["branch", "--show-current"])).toBe(
            FIXTURE_BRANCH,
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
            ...(provider === "codex"
              ? {
                  codexYoloMode: true,
                  codexHookTrustBypassAbsent: true,
                  codexTooltipsDisabled: true,
                  codexHookTrustPreflightSequence: 1,
                }
              : {}),
          });
          if (provider === "opencode") {
            expect(firstLaunches[0]?.args[0]).toBe("--agent");
            expect(firstLaunches[0]?.args[1]).toMatch(/^studio-native-.+/);
            expect(
              hasCliFlag(firstLaunches[0]?.args ?? [], "--model"),
            ).toBeFalse();
          } else if (provider === "codex") {
            expectCodexInteractiveLaunch(firstLaunches[0]!, 1);
            const preflights = await waitForCodexHookTrustPreflightRecords(
              launchLog,
              1,
              expectedCwd,
            );
            expect(preflights).toHaveLength(1);
            expectCodexHookTrustPreflight(preflights[0]!, expectedCwd, 1, true);
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
            ...(provider === "codex"
              ? {
                  codexYoloMode: true,
                  codexHookTrustBypassAbsent: true,
                  codexTooltipsDisabled: true,
                  codexHookTrustPreflightSequence: 2,
                }
              : {}),
          });
          if (provider === "claude-code") {
            expect(launches[1]?.args).toContain("--resume");
          } else if (provider === "codex") {
            expect(launches[1]?.args).toContain("resume");
            expectCodexInteractiveLaunch(launches[1]!, 2);
            const preflights = await waitForCodexHookTrustPreflightRecords(
              launchLog,
              2,
              expectedCwd,
            );
            expect(preflights).toHaveLength(2);
            for (const [index, preflight] of preflights.entries()) {
              expectCodexHookTrustPreflight(
                preflight,
                expectedCwd,
                index + 1,
                index === 0,
              );
            }
          } else {
            expect(launches[1]?.args[0]).toBe("--agent");
            expect(launches[1]?.args[1]).toMatch(/^studio-native-.+/);
            expect(launches[1]?.args.slice(2)).toEqual([
              "--session",
              `studio-e2e-${provider}-session`,
            ]);
            expect(hasCliFlag(launches[1]?.args ?? [], "--model")).toBeFalse();
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

  it(
    "Codex preserves its confirmed resume checkpoint across a SIGKILL before the resume hook",
    async () => {
      if (!api) throw new Error("local-api did not start");
      if (!gitFixture) throw new Error("git fixture was not initialized");

      const provider = "codex";
      const seedPrompt = "seed-codex-restart";
      const seedRequestId = "seed-codex-restart-request";
      const seed = await connectTerminal(
        api,
        CODEX_RESTART_THREAD_ID,
        privateHeaders,
      );
      let restartCwd: string;

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
          "Codex restart seed ready frame",
        );
        await waitForOutput(
          seed,
          `STUB_READY:${provider}:${CODEX_RESTART_SESSION_ID}`,
        );
        await waitForFrame(
          seed,
          (frame) =>
            frame.type === "prompt_accepted" &&
            frame.requestId === seedRequestId,
          "Codex restart seed prompt acceptance",
        );
        await waitForOutput(seed, `STUB_REPLY:${provider}:${seedPrompt}`);
        await waitForFrame(
          seed,
          (frame) =>
            frame.type === "state" &&
            frame.logicalState === "completed" &&
            frame.threadStatus === "completed",
          "Codex restart seed completion",
        );
        await waitForProviderCheckpoint(
          api,
          CODEX_RESTART_THREAD_ID,
          privateHeaders,
        );

        restartCwd = realpathSync(
          repoDirFor(
            api.workdir,
            computeHandle(gitFixture.bareDir, CODEX_RESTART_BRANCH),
          ),
        );
        const launches = await waitForLaunchRecords(
          launchLog,
          provider,
          1,
          restartCwd,
        );
        expect(launches).toHaveLength(1);
        expect(launches[0]?.resumeId).toBeNull();
        expect(launches[0]?.heldResumeHook).toBeUndefined();
        const seedExit = await terminateAndWaitForExit(seed, launches[0]!);
        expect(seedExit.expected).toBe(true);
      } finally {
        seed.socket.close();
      }

      const held = await connectTerminal(
        api,
        CODEX_RESTART_THREAD_ID,
        privateHeaders,
      );
      let heldLaunch: LaunchRecord;
      try {
        held.socket.send(
          JSON.stringify({
            type: "start",
            harnessId: provider,
            rows: 30,
            cols: 100,
          }),
        );
        await waitForFrame(
          held,
          (frame) => frame.type === "ready",
          "Codex held-resume ready frame",
        );
        await waitForOutput(
          held,
          `STUB_READY:${provider}:${CODEX_RESTART_SESSION_ID}`,
        );

        const launches = await waitForLaunchRecords(
          launchLog,
          provider,
          2,
          restartCwd,
        );
        expect(launches.map((launch) => launch.resumeId)).toEqual([
          null,
          CODEX_RESTART_SESSION_ID,
        ]);
        expect(launches[1]?.heldResumeHook).toBe(true);
        expect(readFileSync(heldCodexResumeHookSentinel, "utf8")).toBe(
          `${CODEX_RESTART_SESSION_ID}\n`,
        );
        heldLaunch = launches[1]!;
        expect(processIsAlive(heldLaunch.pid)).toBe(true);

        const interruptedApi = api;
        const persistentWorkdir = interruptedApi.workdir;
        expect(interruptedApi.proc.exitCode).toBeNull();
        expect(interruptedApi.proc.signalCode).toBeNull();
        await stopLocalApi(interruptedApi, { keepWorkdir: true });
        expect(interruptedApi.proc.signalCode).toBe("SIGKILL");

        const restartedApi = await startEmbeddedLocalApi(fixtureEnvironment(), {
          workdir: persistentWorkdir,
        });
        api = restartedApi;
        privateHeaders = await authenticateEmbeddedApi(restartedApi);
        expect(restartedApi.workdir).toBe(persistentWorkdir);
        expect(processIsAlive(heldLaunch.pid)).toBe(false);
      } finally {
        held.socket.close();
      }

      const resumed = await connectTerminal(
        api,
        CODEX_RESTART_THREAD_ID,
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
        await waitForFrame(
          resumed,
          (frame) => frame.type === "ready",
          "Codex post-restart resumed ready frame",
        );
        await waitForOutput(
          resumed,
          `STUB_READY:${provider}:${CODEX_RESTART_SESSION_ID}`,
        );

        const launches = await waitForLaunchRecords(
          launchLog,
          provider,
          3,
          restartCwd,
        );
        expect(launches).toHaveLength(3);
        expect(launches.map((launch) => launch.resumeId)).toEqual([
          null,
          CODEX_RESTART_SESSION_ID,
          CODEX_RESTART_SESSION_ID,
        ]);
        expect(launches.map((launch) => launch.heldResumeHook)).toEqual([
          undefined,
          true,
          undefined,
        ]);
        const resumeIndex = launches[2]!.args.indexOf("resume");
        expect(launches[2]!.args.slice(resumeIndex, resumeIndex + 2)).toEqual([
          "resume",
          CODEX_RESTART_SESSION_ID,
        ]);
        await waitForProviderCheckpoint(
          api,
          CODEX_RESTART_THREAD_ID,
          privateHeaders,
        );

        const resumedExit = await terminateAndWaitForExit(
          resumed,
          launches[2]!,
        );
        expect(resumedExit.expected).toBe(true);
      } finally {
        resumed.socket.close();
      }
    },
    HOOK_TIMEOUT_MS * 2,
  );

  it(
    "logout waits for a held Codex hook preflight to be fully reaped",
    async () => {
      if (!api) throw new Error("local-api did not start");

      const terminal = await connectTerminal(
        api,
        CODEX_PREFLIGHT_FENCE_THREAD_ID,
        privateHeaders,
      );
      let preflightPid: number | null = null;
      try {
        terminal.socket.send(
          JSON.stringify({
            type: "start",
            harnessId: "codex",
            rows: 30,
            cols: 100,
          }),
        );
        const sentinel = await waitForCodexPreflightFenceSentinel(
          codexPreflightFenceSentinel,
        );
        preflightPid = sentinel.pid;
        const stoppedState = spawnSync(
          "/bin/ps",
          ["-o", "stat=", "-p", String(preflightPid)],
          { encoding: "utf8" },
        ).stdout.trim();
        const aliveWhileStopped = processIsAlive(preflightPid);
        const launchesWhileStopped = launchRecords(
          launchLog,
          "codex",
          sentinel.cwd,
        );

        let logoutSettled = false;
        const logoutPromise = fetch(url(api, "/_auth/logout"), {
          method: "POST",
          headers: privateHeaders,
        })
          .then(
            (response) => ({ response, error: null }),
            (error: unknown) => ({ response: null, error }),
          )
          .finally(() => {
            logoutSettled = true;
          });
        await sleep(150);
        const settledWhileStopped = logoutSettled;
        const helperAliveWhileLogoutBlocked = processIsAlive(preflightPid);
        const interactiveLaunchesWhileBlocked = launchRecords(
          launchLog,
          "codex",
          sentinel.cwd,
        );

        process.kill(preflightPid, "SIGCONT");
        const logoutResult = await logoutPromise;
        if (logoutResult.error) throw logoutResult.error;
        if (!logoutResult.response) {
          throw new Error("native logout did not return a response");
        }
        const logoutBody = (await logoutResult.response.json()) as {
          signedIn?: boolean;
        };
        await waitForProcessExit(preflightPid);

        expect(stoppedState.startsWith("T")).toBe(true);
        expect(aliveWhileStopped).toBe(true);
        expect(launchesWhileStopped).toHaveLength(0);
        expect(settledWhileStopped).toBe(false);
        expect(helperAliveWhileLogoutBlocked).toBe(true);
        expect(interactiveLaunchesWhileBlocked).toHaveLength(0);
        expect(logoutResult.response.status).toBe(200);
        expect(logoutBody.signedIn).toBe(false);
        expect(processIsAlive(preflightPid)).toBe(false);
      } finally {
        if (preflightPid !== null && processIsAlive(preflightPid)) {
          process.kill(preflightPid, "SIGCONT");
        }
        terminal.socket.close();
      }
    },
    HOOK_TIMEOUT_MS,
  );
});
