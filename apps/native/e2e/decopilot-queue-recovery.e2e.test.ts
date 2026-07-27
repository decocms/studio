/**
 * Black-box durability/lifecycle contract for native Decopilot's SQLite FIFO.
 *
 * These tests deliberately kill and relaunch the REAL local-api process. They
 * never import Rust/app implementation code and never invoke a paid CLI: the
 * deterministic stub harness is selected through the public env contract.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { retry, sleep } from "@decocms/shared/std";
import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import {
  authHeaders,
  describeLocalApi,
  jsonAuthHeaders,
  type LocalApi,
  resolveLocalApiCmd,
  startLocalApi,
  stopLocalApi,
  stubClaudeBinEnv,
  url,
} from "./helpers";

const STUB_CODEX_PATH = fileURLToPath(
  new URL("./fixtures/stub-codex-resume.mjs", import.meta.url),
);

interface QueueItem {
  workflowId: string;
  messageId: string;
  status: "running" | "queued";
}

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
  metadata?: Record<string, unknown>;
  seq: number;
}

interface StubInvocation {
  pid: number;
  scenario: string;
  ownership?: string;
  descendantPid?: number;
  prompt?: string;
  resumeSessionId?: string | null;
  args?: string[];
}

interface StubSignal {
  pid: number;
  signal: "SIGTERM";
  at: number;
}

interface StubDescendant {
  pid: number;
  parentPid: number;
  ownership: string;
  event: "ready" | "SIGTERM";
}

interface OwnedProcess {
  pid: number;
  ownership: string;
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

const AUTH_SESSION_COOKIE = "better-auth.session_token=queue-recovery-session";

/** Minimal Better-Auth/OAuth issuer used only to put a real account scope in
 * the standalone local-api process. The queue test remains black-box: it signs
 * in over the same public routes as the app and never imports Rust internals. */
function startAuthStubMesh() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const requestUrl = new URL(req.url);
      if (
        requestUrl.pathname === "/api/auth/sign-in/email" &&
        req.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ user: { id: "queue-recovery-user" } }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `${AUTH_SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }
      if (
        requestUrl.pathname === "/api/auth/mcp/register" &&
        req.method === "POST"
      ) {
        return Response.json({ client_id: "queue-recovery-client" });
      }
      if (
        requestUrl.pathname === "/api/auth/mcp/authorize" &&
        req.method === "GET"
      ) {
        if (req.headers.get("cookie") !== AUTH_SESSION_COOKIE) {
          return new Response("no session", { status: 401 });
        }
        const target = new URL(requestUrl.searchParams.get("redirect_uri")!);
        target.searchParams.set("code", "queue-recovery-auth-code");
        target.searchParams.set(
          "state",
          requestUrl.searchParams.get("state") ?? "",
        );
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }
      if (
        requestUrl.pathname === "/api/auth/mcp/token" &&
        req.method === "POST"
      ) {
        return Response.json({
          access_token: "queue-recovery-access-token",
          refresh_token: "queue-recovery-refresh-token",
          expires_in: 3600,
          id_token: fakeIdToken({
            sub: "queue-recovery-user",
            email: "queue-recovery@example.test",
            name: "Queue Recovery User",
          }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://localhost:${server.port}` };
}

const RETRY_OPTIONS = {
  maxAttempts: 100,
  minTimeout: 20,
  maxTimeout: 100,
  jitter: 0,
} as const;

function invocationLog(workdir: string): string {
  return join(workdir, "stub-harness-invocations.jsonl");
}

function signalLog(workdir: string): string {
  return join(workdir, "stub-harness-signals.jsonl");
}

function descendantLog(workdir: string): string {
  return join(workdir, "stub-harness-descendants.jsonl");
}

function readJsonLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function readInvocations(path: string): StubInvocation[] {
  return readJsonLines<StubInvocation>(path);
}

function readSessionCheckpoint(
  workdir: string,
  workflowId: string,
): { harnessId: string; sessionId: string } | null {
  const database = new Database(join(workdir, ".decocms", "local.db"), {
    readonly: true,
  });
  try {
    return (
      database
        .query<{ harnessId: string; sessionId: string }, [string]>(
          "SELECT checkpoint_harness_id AS harnessId, \
                  checkpoint_session_id AS sessionId \
           FROM native_scoped_turn_queue \
           WHERE workflow_id = ?1 AND state IN ('running', 'cancel_requested')",
        )
        .get(workflowId) ?? null
    );
  } finally {
    database.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync(
      "/bin/ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Test cleanup must never kill a retained bare pid: macOS can reuse it after
 * the original stub exits. The random ownership marker is present in both the
 * direct harness prompt and descendant argv; only that exact command may be
 * cleaned up. A missing/mismatched command means the owned process is already
 * gone (and possibly the pid now belongs to somebody else), so leave it alone.
 */
function killIfStillOwned({ pid, ownership }: OwnedProcess): void {
  if (!processIsAlive(pid)) return;
  const command = processCommand(pid);
  if (
    !command?.includes(`OWNERSHIP:${ownership}`) &&
    !command?.includes(ownership)
  ) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function dispatchTurn(
  api: LocalApi,
  org: string,
  threadId: string,
  messageId: string,
  text: string,
  harnessId = "claude-code",
): Promise<Response> {
  return fetch(url(api, `/api/${org}/decopilot/threads/${threadId}/messages`), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      messages: [
        {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text }],
        },
      ],
      harnessId,
      tier: "smart",
      mode: "default",
      toolApprovalLevel: "auto",
    }),
  });
}

async function listQueue(
  api: LocalApi,
  org: string,
  threadId: string,
): Promise<QueueItem[]> {
  const res = await fetch(url(api, `/api/${org}/decopilot/queue/${threadId}`), {
    headers: jsonAuthHeaders(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: QueueItem[] }).items;
}

async function listMessages(
  api: LocalApi,
  org: string,
  threadId: string,
): Promise<MessageItem[]> {
  const res = await fetch(
    url(api, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
    {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        thread_id: threadId,
        limit: 100,
        orderBy: [{ field: ["created_at"], direction: "asc" }],
      }),
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: MessageItem[] }).items;
}

async function createThread(
  api: LocalApi,
  org: string,
  threadId: string,
): Promise<Response> {
  return fetch(url(api, `/api/${org}/tools/COLLECTION_THREADS_CREATE`), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      data: {
        id: threadId,
        title: "queue recovery thread",
        virtual_mcp_id: "vmcp-recreated",
      },
    }),
  });
}

async function deleteThread(
  api: LocalApi,
  org: string,
  threadId: string,
): Promise<Response> {
  return fetch(url(api, `/api/${org}/tools/COLLECTION_THREADS_DELETE`), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ id: threadId }),
  });
}

async function waitForExit(api: LocalApi, timeoutMs = 15_000): Promise<void> {
  if (api.proc.exitCode !== null || api.proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    api.proc.once("exit", () => resolve());
  });
  await Promise.race([
    exited,
    sleep(timeoutMs).then(() => {
      throw new Error(`local-api did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

let liveApi: LocalApi | null = null;
let authStub: ReturnType<typeof startAuthStubMesh> | null = null;
const cleanupDirs = new Set<string>();
const cleanupProcesses = new Map<number, OwnedProcess>();

async function startAuthenticatedLocalApi(
  extraEnv: Record<string, string>,
  opts: { workdir: string; onListening?: () => void },
): Promise<LocalApi> {
  authStub ??= startAuthStubMesh();
  const api = await startLocalApi(
    {
      ...extraEnv,
      DECOCMS_UPSTREAM_URL: authStub.url,
      // Every crash/relaunch below authenticates explicitly. Keeping the test
      // session in memory avoids touching a developer's OS credential store.
      LOCAL_API_TOKEN_STORE: "memory",
    },
    opts,
  );
  opts.onListening?.();
  const signIn = await fetch(url(api, "/api/auth/sign-in/email"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      email: "queue-recovery@example.test",
      password: "hunter2",
    }),
  });
  if (signIn.status !== 200) {
    throw new Error(`queue test sign-in failed: ${signIn.status}`);
  }
  const complete = await fetch(url(api, "/_auth/complete-session"), {
    method: "POST",
    headers: authHeaders(),
  });
  if (complete.status !== 200) {
    throw new Error(`queue test auth bridge failed: ${complete.status}`);
  }
  return api;
}

afterEach(async () => {
  await stopLocalApi(liveApi, { keepWorkdir: true });
  liveApi = null;
  authStub?.server.stop(true);
  authStub = null;
  for (const owned of cleanupProcesses.values()) killIfStillOwned(owned);
  cleanupProcesses.clear();
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describeLocalApi("local-api e2e: durable Decopilot queue lifecycle", () => {
  it("rejects a second process on the same app root and releases the kernel lock on exit", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "decopilot-instance-lock-"));
    cleanupDirs.add(workdir);
    liveApi = await startAuthenticatedLocalApi({}, { workdir });

    const command = resolveLocalApiCmd();
    if (!command) throw new Error("LOCAL_API_E2E_CMD unexpectedly missing");
    const binary = command[0]!;
    const args = command.slice(1);
    const contender = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        LOCAL_API_TOKEN: "c".repeat(32),
        LOCAL_API_BOOT_ID: "instance-lock-contender",
        LOCAL_API_WORKDIR: workdir,
        LOCAL_API_PORT: "0",
        LOCAL_API_TOKEN_STORE: "memory",
      },
    });
    let stderr = "";
    contender.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => {
        contender.once("exit", (code) => resolve(code));
      }),
      sleep(10_000).then(() => {
        contender.kill("SIGKILL");
        throw new Error("second local-api did not reject the owned app root");
      }),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("another local-api instance already owns");
    expect((await fetch(url(liveApi, "/health"))).status).toBe(200);

    await stopLocalApi(liveApi, { keepWorkdir: true });
    liveApi = null;
    liveApi = await startAuthenticatedLocalApi({}, { workdir });
    expect((await fetch(url(liveApi, "/health"))).status).toBe(200);
  });

  it("fails a nominally successful first turn that has no resumable session id", async () => {
    const org = "missing-session-org";
    const threadId = "missing-session-thread";
    const workdir = mkdtempSync(join(tmpdir(), "decopilot-missing-session-"));
    cleanupDirs.add(workdir);
    liveApi = await startAuthenticatedLocalApi(stubClaudeBinEnv(), { workdir });

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          "missing-session-user",
          "SCENARIO:nosession",
        )
      ).status,
    ).toBe(202);
    const messages = await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 2 || queue.length !== 0) {
        throw new Error(
          `missing-session turn has not finalized: ${JSON.stringify({
            messages,
            queue,
          })}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);

    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.metadata?.finishReason).toBe("error");
    expect(
      assistant?.parts.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "data-harness-session",
      ),
    ).toBe(false);
  });

  it("checkpoints a session before content and resumes only the newest prompt after process death", async () => {
    const org = "checkpoint-recovery-org";
    const threadId = "checkpoint-recovery-thread";
    const firstMessageId = "checkpoint-first-user";
    const secondMessageId = "checkpoint-second-user";
    const workflowId = `thread-run:${threadId}:${firstMessageId}`;
    const expectedSessionId = "11111111-1111-4111-8111-checkpoint00";
    const ownership = randomUUID();
    const firstPrompt = `SCENARIO:checkpoint OWNERSHIP:${ownership} FIRST_ONLY_9307e6`;
    const secondPrompt = "SCENARIO:checkpoint SECOND_ONLY_bf7f25";
    const workdir = mkdtempSync(
      join(tmpdir(), "decopilot-session-checkpoint-"),
    );
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    const stubEnv = stubClaudeBinEnv({
      STUB_HARNESS_INVOCATION_LOG: logPath,
    });
    liveApi = await startAuthenticatedLocalApi(stubEnv, { workdir });

    expect(
      (await dispatchTurn(liveApi, org, threadId, firstMessageId, firstPrompt))
        .status,
    ).toBe(202);
    const firstInvocation = await retry(async () => {
      const invocation = readInvocations(logPath)[0];
      const checkpoint = readSessionCheckpoint(workdir, workflowId);
      if (
        !invocation ||
        invocation.scenario !== "checkpoint" ||
        invocation.ownership !== ownership ||
        checkpoint?.harnessId !== "claude-code" ||
        checkpoint.sessionId !== expectedSessionId
      ) {
        throw new Error(
          `session event is not durable yet: ${JSON.stringify({
            invocation,
            checkpoint,
          })}`,
        );
      }
      return invocation;
    }, RETRY_OPTIONS);
    cleanupProcesses.set(firstInvocation.pid, {
      pid: firstInvocation.pid,
      ownership,
    });

    expect(liveApi.proc.kill("SIGKILL")).toBe(true);
    await waitForExit(liveApi);
    liveApi = null;
    killIfStillOwned({ pid: firstInvocation.pid, ownership });
    await retry(async () => {
      if (processIsAlive(firstInvocation.pid)) {
        throw new Error("pre-crash harness process is still alive");
      }
    }, RETRY_OPTIONS);
    cleanupProcesses.delete(firstInvocation.pid);

    liveApi = await startAuthenticatedLocalApi(stubEnv, { workdir });
    const recovered = await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 2 || queue.length !== 0) {
        throw new Error(
          `orphan checkpoint has not finalized: ${JSON.stringify({
            messages,
            queue,
          })}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);
    expect(recovered[1]?.metadata?.interrupted).toBe(true);
    expect(recovered[1]?.parts).toContainEqual({
      type: "data-harness-session",
      harnessId: "claude-code",
      sessionId: expectedSessionId,
    });

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          secondMessageId,
          secondPrompt,
        )
      ).status,
    ).toBe(202);
    await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 4 || queue.length !== 0) {
        throw new Error(
          `resumed turn has not finalized: ${JSON.stringify({
            messages,
            queue,
          })}`,
        );
      }
    }, RETRY_OPTIONS);

    const invocations = readInvocations(logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.prompt).toBe(firstPrompt);
    expect(invocations[0]?.resumeSessionId).toBeNull();
    expect(invocations[1]?.prompt).toBe(secondPrompt);
    expect(invocations[1]?.resumeSessionId).toBe(expectedSessionId);
    expect(invocations[1]?.args?.join("\0")).not.toContain("FIRST_ONLY_9307e6");
  }, 30_000);

  it("checkpoints and resumes a Codex thread across local-api process death", async () => {
    const org = "codex-checkpoint-recovery-org";
    const threadId = "codex-checkpoint-recovery-thread";
    const firstMessageId = "codex-checkpoint-first-user";
    const secondMessageId = "codex-checkpoint-second-user";
    const workflowId = `thread-run:${threadId}:${firstMessageId}`;
    const expectedSessionId = "019f7325-3e34-7b30-863a-861396b02def";
    const ownership = randomUUID();
    const firstPrompt = `CHECKPOINT_FIRST OWNERSHIP:${ownership} CODEX_FIRST_ONLY_d8b51e`;
    const secondPrompt = "CHECKPOINT_SECOND CODEX_SECOND_ONLY_012daf";
    const workdir = mkdtempSync(
      join(tmpdir(), "decopilot-codex-session-checkpoint-"),
    );
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    const stubEnv = {
      LOCAL_API_CLAUDE_BIN: join(workdir, "missing-claude"),
      LOCAL_API_CODEX_BIN: JSON.stringify(["node", STUB_CODEX_PATH]),
      STUB_CODEX_INVOCATION_LOG: logPath,
    };
    liveApi = await startAuthenticatedLocalApi(stubEnv, { workdir });

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          firstMessageId,
          firstPrompt,
          "codex",
        )
      ).status,
    ).toBe(202);
    const firstInvocation = await retry(async () => {
      const invocation = readInvocations(logPath)[0];
      const checkpoint = readSessionCheckpoint(workdir, workflowId);
      if (
        !invocation ||
        invocation.ownership !== ownership ||
        checkpoint?.harnessId !== "codex" ||
        checkpoint.sessionId !== expectedSessionId
      ) {
        throw new Error(
          `Codex session event is not durable yet: ${JSON.stringify({
            invocation,
            checkpoint,
          })}`,
        );
      }
      return invocation;
    }, RETRY_OPTIONS);
    cleanupProcesses.set(firstInvocation.pid, {
      pid: firstInvocation.pid,
      ownership,
    });

    expect(liveApi.proc.kill("SIGKILL")).toBe(true);
    await waitForExit(liveApi);
    liveApi = null;
    killIfStillOwned({ pid: firstInvocation.pid, ownership });
    await retry(async () => {
      if (processIsAlive(firstInvocation.pid)) {
        throw new Error("pre-crash Codex process is still alive");
      }
    }, RETRY_OPTIONS);
    cleanupProcesses.delete(firstInvocation.pid);

    liveApi = await startAuthenticatedLocalApi(stubEnv, { workdir });
    const recovered = await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 2 || queue.length !== 0) {
        throw new Error(
          `Codex orphan checkpoint has not finalized: ${JSON.stringify({
            messages,
            queue,
          })}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);
    expect(recovered[1]?.parts).toContainEqual({
      type: "data-harness-session",
      harnessId: "codex",
      sessionId: expectedSessionId,
    });

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          secondMessageId,
          secondPrompt,
          "codex",
        )
      ).status,
    ).toBe(202);
    await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 4 || queue.length !== 0) {
        throw new Error(
          `resumed Codex turn has not finalized: ${JSON.stringify({
            messages,
            queue,
          })}`,
        );
      }
    }, RETRY_OPTIONS);

    const invocations = readInvocations(logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.prompt).toBe(firstPrompt);
    expect(invocations[0]?.resumeSessionId).toBeNull();
    expect(invocations[1]?.prompt).toBe(secondPrompt);
    expect(invocations[1]?.resumeSessionId).toBe(expectedSessionId);
    expect(invocations[1]?.args?.join("\0")).not.toContain(
      "CODEX_FIRST_ONLY_d8b51e",
    );
  }, 30_000);

  it("reserves global message identities before 202 and never reruns an exact completed retry", async () => {
    const org = "queue-id-reservation-org";
    const firstThread = "queue-id-reservation-first";
    const secondThread = "queue-id-reservation-second";
    const messageId = "queue-id-reservation-message";
    const workdir = mkdtempSync(
      join(tmpdir(), "decopilot-queue-id-reservation-"),
    );
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    liveApi = await startAuthenticatedLocalApi(
      stubClaudeBinEnv({ STUB_HARNESS_INVOCATION_LOG: logPath }),
      { workdir },
    );

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          firstThread,
          messageId,
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(202);
    const completed = await retry(async () => {
      const messages = await listMessages(liveApi!, org, firstThread);
      if (messages.length !== 2 || readInvocations(logPath).length !== 1) {
        throw new Error(
          `first turn is not complete: ${JSON.stringify(messages)}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);
    expect(completed[1]?.id).toMatch(/^native-assistant:v1:[0-9a-f]{64}$/);

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          firstThread,
          messageId,
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(202);
    await sleep(100);
    expect(readInvocations(logPath)).toHaveLength(1);

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          secondThread,
          messageId,
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          secondThread,
          "native-assistant:v99:caller-controlled",
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(400);
    await sleep(100);
    expect(readInvocations(logPath)).toHaveLength(1);
    expect(await listQueue(liveApi, org, secondThread)).toEqual([]);
  });

  it("SIGKILL + relaunch fails the indeterminate active head without rerunning it, then resumes the queued tail FIFO", async () => {
    const org = "queue-recovery-org";
    const threadId = "queue-recovery-thread";
    const firstId = "queue-recovery-first";
    const secondId = "queue-recovery-second";

    const workdir = mkdtempSync(join(tmpdir(), "decopilot-queue-recovery-"));
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    const descendantPath = descendantLog(workdir);
    const ownership = `queue-recovery-${randomUUID()}`;
    const stubEnv = stubClaudeBinEnv({
      STUB_HARNESS_INVOCATION_LOG: logPath,
      STUB_HARNESS_DESCENDANT_LOG: descendantPath,
    });
    liveApi = await startAuthenticatedLocalApi(stubEnv, { workdir });

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          firstId,
          `SCENARIO:termresist OWNERSHIP:${ownership}`,
        )
      ).status,
    ).toBe(202);
    expect(
      (await dispatchTurn(liveApi, org, threadId, secondId, "SCENARIO:simple"))
        .status,
    ).toBe(202);

    const firstRun = await retry(async () => {
      const queue = await listQueue(liveApi!, org, threadId);
      if (
        queue.length !== 2 ||
        queue[0]?.messageId !== firstId ||
        queue[0]?.status !== "running" ||
        queue[1]?.messageId !== secondId ||
        queue[1]?.status !== "queued"
      ) {
        throw new Error(
          `queue has not reached running+queued: ${JSON.stringify(queue)}`,
        );
      }
      const messages = await listMessages(liveApi!, org, threadId);
      if (
        messages.length !== 1 ||
        messages[0]?.id !== firstId ||
        messages[0]?.role !== "user"
      ) {
        throw new Error(
          `active user is not the sole durable message: ${JSON.stringify(messages)}`,
        );
      }
      const invocations = readInvocations(logPath);
      if (
        invocations.length !== 1 ||
        invocations[0]?.scenario !== "termresist" ||
        invocations[0]?.ownership !== ownership ||
        typeof invocations[0]?.descendantPid !== "number"
      ) {
        throw new Error(
          `stub head has not started exactly once: ${JSON.stringify(invocations)}`,
        );
      }
      const invocation = invocations[0]!;
      const descendant = readJsonLines<StubDescendant>(descendantPath).find(
        (entry) =>
          entry.event === "ready" &&
          entry.parentPid === invocation.pid &&
          entry.pid === invocation.descendantPid &&
          entry.ownership === ownership,
      );
      if (
        !descendant ||
        !processIsAlive(invocation.pid) ||
        !processIsAlive(descendant.pid)
      ) {
        throw new Error(
          `TERM-resistant process tree is not ready: ${JSON.stringify({ invocation, descendant })}`,
        );
      }
      return { invocation, descendant };
    }, RETRY_OPTIONS);
    cleanupProcesses.set(firstRun.invocation.pid, {
      pid: firstRun.invocation.pid,
      ownership,
    });
    cleanupProcesses.set(firstRun.descendant.pid, {
      pid: firstRun.descendant.pid,
      ownership,
    });

    // A real process crash: no local-api shutdown hooks run. Relaunch
    // IMMEDIATELY after the old process exits, before waiting for either old
    // harness pid. The replacement owns the released main instance lock but
    // must remain pre-ready on the separate child-lifetime EXCLUSIVE fence
    // while the crash watchdog holds SHARED ownership and reaps this
    // deliberately TERM-resistant tree.
    await stopLocalApi(liveApi, { keepWorkdir: true });
    liveApi = null;
    let relaunchListening = false;
    const relaunchOutcome = startAuthenticatedLocalApi(stubEnv, {
      workdir,
      onListening: () => {
        relaunchListening = true;
      },
    }).then(
      (api) => ({ api }) as const,
      (error: unknown) => ({ error }) as const,
    );

    // Both fixture processes ignore TERM, so the watchdog's one-second grace
    // gives the successor time to reach (and block on) its recovery fence. If
    // it exposes /health or promotes the queued tail during this interval,
    // the cross-process ownership contract is broken.
    await sleep(100);
    expect(
      processIsAlive(firstRun.invocation.pid) ||
        processIsAlive(firstRun.descendant.pid),
    ).toBe(true);
    expect(relaunchListening).toBe(false);
    expect(readInvocations(logPath).map((entry) => entry.scenario)).toEqual([
      "termresist",
    ]);

    await retry(async () => {
      const directAlive = processIsAlive(firstRun.invocation.pid);
      const descendantAlive = processIsAlive(firstRun.descendant.pid);
      const descendantSawTerm = readJsonLines<StubDescendant>(
        descendantPath,
      ).some(
        (entry) =>
          entry.pid === firstRun.descendant.pid && entry.event === "SIGTERM",
      );
      if (directAlive || descendantAlive) {
        if (relaunchListening) {
          throw new Error(
            "replacement local-api became ready before the old process tree was reaped",
          );
        }
        if (
          readInvocations(logPath).some((entry) => entry.scenario === "simple")
        ) {
          throw new Error(
            "queued successor was invoked before the old process tree was reaped",
          );
        }
        throw new Error(
          `parent-death watchdog is still reaping: ${JSON.stringify({ directAlive, descendantAlive, descendantSawTerm })}`,
        );
      }
      if (!descendantSawTerm) {
        throw new Error(
          `parent-death watchdog did not TERM→KILL the process tree: ${JSON.stringify({ directAlive, descendantAlive, descendantSawTerm })}`,
        );
      }
    }, RETRY_OPTIONS);
    cleanupProcesses.delete(firstRun.invocation.pid);
    cleanupProcesses.delete(firstRun.descendant.pid);
    expect(readInvocations(logPath).map((entry) => entry.scenario)).toEqual([
      "termresist",
    ]);

    const outcome = await relaunchOutcome;
    if ("error" in outcome) throw outcome.error;
    liveApi = outcome.api;

    const recovered = await retry(async () => {
      const messages = await listMessages(liveApi!, org, threadId);
      const queue = await listQueue(liveApi!, org, threadId);
      if (messages.length !== 4 || queue.length !== 0) {
        throw new Error(
          `recovery incomplete: messages=${messages.length} queue=${JSON.stringify(queue)}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);

    expect(recovered.map(({ role, seq }) => ({ role, seq }))).toEqual([
      { role: "user", seq: 1 },
      { role: "assistant", seq: 2 },
      { role: "user", seq: 3 },
      { role: "assistant", seq: 4 },
    ]);
    expect(recovered[0]?.id).toBe(firstId);
    expect(recovered[2]?.id).toBe(secondId);
    for (const [assistant, userId] of [
      [recovered[1], firstId],
      [recovered[3], secondId],
    ] as const) {
      expect(assistant?.id).toMatch(/^native-assistant:v1:[0-9a-f]{64}$/);
      expect(assistant?.id).not.toBe(`msg-${userId}-assistant`);
    }
    // The accepted-but-indeterminate active agent is not replayed: its
    // deterministic assistant row explicitly tells the user what happened.
    expect(JSON.stringify(recovered[1]?.parts).toLowerCase()).toContain(
      "interrupted",
    );

    const invocations = readInvocations(logPath);
    expect(invocations.map((entry) => entry.scenario)).toEqual([
      "termresist",
      "simple",
    ]);
  }, 30_000);

  it("delete waits for a hanging active turn, permanently retires its id, and rejects a delayed old POST", async () => {
    const org = "queue-delete-org";
    const threadId = "queue-delete-thread";
    const oldMessageId = "queue-delete-old";
    // Minted before DELETE but deliberately delivered only after it commits:
    // this is the request that used to resurrect the public thread id.
    const delayedMessageId = "queue-delete-delayed-old";
    const replacementThreadId = "queue-delete-replacement-thread";
    const replacementMessageId = "queue-delete-replacement-message";

    const workdir = mkdtempSync(join(tmpdir(), "decopilot-queue-delete-"));
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    const signalPath = signalLog(workdir);
    const ownership = `queue-delete-${randomUUID()}`;
    liveApi = await startAuthenticatedLocalApi(
      stubClaudeBinEnv({
        STUB_HARNESS_INVOCATION_LOG: logPath,
        STUB_HARNESS_SIGNAL_LOG: signalPath,
      }),
      { workdir },
    );

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          oldMessageId,
          `SCENARIO:termresist OWNERSHIP:${ownership}`,
        )
      ).status,
    ).toBe(202);
    const hanging = await retry(async () => {
      const invocation = readInvocations(logPath)[0];
      const queue = await listQueue(liveApi!, org, threadId);
      if (
        !invocation ||
        invocation.scenario !== "termresist" ||
        invocation.ownership !== ownership ||
        !processIsAlive(invocation.pid)
      ) {
        throw new Error("hanging harness is not alive yet");
      }
      if (
        queue[0]?.messageId !== oldMessageId ||
        queue[0]?.status !== "running"
      ) {
        throw new Error(
          `old generation is not running: ${JSON.stringify(queue)}`,
        );
      }
      return invocation;
    }, RETRY_OPTIONS);
    cleanupProcesses.set(hanging.pid, { pid: hanging.pid, ownership });

    const deletePromise = deleteThread(liveApi, org, threadId);
    await retry(async () => {
      const signals = readJsonLines<StubSignal>(signalPath);
      if (
        !signals.some(
          (signal) => signal.pid === hanging.pid && signal.signal === "SIGTERM",
        )
      ) {
        throw new Error("delete has not entered active-turn quiescence yet");
      }
    }, RETRY_OPTIONS);

    // While DELETE is waiting for TERM→KILL escalation, the old generation
    // is visibly closing. Neither a new turn nor an explicit same-id CREATE
    // may sneak through, and neither may launch a second harness.
    const sendWhileClosing = await dispatchTurn(
      liveApi,
      org,
      threadId,
      "queue-delete-during-close",
      "SCENARIO:simple",
    );
    expect(sendWhileClosing.status).toBe(409);
    expect((await createThread(liveApi, org, threadId)).status).toBe(409);
    expect(readInvocations(logPath).map((entry) => entry.scenario)).toEqual([
      "termresist",
    ]);

    const deleted = await deletePromise;
    expect(deleted.status).toBe(200);
    await retry(async () => {
      if (processIsAlive(hanging.pid)) {
        throw new Error("delete returned before the active harness exited");
      }
    }, RETRY_OPTIONS);
    cleanupProcesses.delete(hanging.pid);
    expect(await listQueue(liveApi, org, threadId)).toEqual([]);

    // DELETE is permanent for this public id in this account + org. Both an
    // explicit stale CREATE and a pre-delete message delivered late must fail
    // before anything reaches the harness.
    expect((await createThread(liveApi, org, threadId)).status).toBe(409);
    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          delayedMessageId,
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(410);
    expect(readInvocations(logPath).map((entry) => entry.scenario)).toEqual([
      "termresist",
    ]);

    // A genuinely new thread id remains healthy; retiring one id must not
    // poison dispatch for the rest of the account/org.
    expect((await createThread(liveApi, org, replacementThreadId)).status).toBe(
      200,
    );
    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          replacementThreadId,
          replacementMessageId,
          "SCENARIO:simple",
        )
      ).status,
    ).toBe(202);

    const recreated = await retry(async () => {
      const messages = await listMessages(liveApi!, org, replacementThreadId);
      if (
        messages.length !== 2 ||
        (await listQueue(liveApi!, org, replacementThreadId)).length !== 0
      ) {
        throw new Error(
          `replacement thread is incomplete: ${JSON.stringify(messages)}`,
        );
      }
      return messages;
    }, RETRY_OPTIONS);
    expect(recreated.map(({ role, seq }) => ({ role, seq }))).toEqual([
      { role: "user", seq: 1 },
      { role: "assistant", seq: 2 },
    ]);
    expect(recreated[0]?.id).toBe(replacementMessageId);
    expect(recreated[1]?.id).toMatch(/^native-assistant:v1:[0-9a-f]{64}$/);

    // Give a wrongly-detached old worker a chance to expose itself. The
    // retired id stays empty and cannot absorb the replacement's transcript.
    await sleep(200);
    expect(await listMessages(liveApi, org, threadId)).toEqual([]);
    expect(await listMessages(liveApi, org, replacementThreadId)).toEqual(
      recreated,
    );
    expect(readInvocations(logPath).map((entry) => entry.scenario)).toEqual([
      "termresist",
      "simple",
    ]);
  }, 30_000);

  it("reaps a fatal-then-hanging harness before promoting the queued successor", async () => {
    const org = "queue-fatal-reap-org";
    const threadId = "queue-fatal-reap-thread";
    const firstId = "queue-fatal-reap-first";
    const secondId = "queue-fatal-reap-second";
    const workdir = mkdtempSync(join(tmpdir(), "decopilot-queue-fatal-reap-"));
    cleanupDirs.add(workdir);
    const logPath = invocationLog(workdir);
    const signalPath = signalLog(workdir);
    const ownership = `queue-fatal-reap-${randomUUID()}`;
    liveApi = await startAuthenticatedLocalApi(
      stubClaudeBinEnv({
        STUB_HARNESS_INVOCATION_LOG: logPath,
        STUB_HARNESS_SIGNAL_LOG: signalPath,
      }),
      { workdir },
    );

    expect(
      (
        await dispatchTurn(
          liveApi,
          org,
          threadId,
          firstId,
          `SCENARIO:fatalhang OWNERSHIP:${ownership}`,
        )
      ).status,
    ).toBe(202);
    expect(
      (await dispatchTurn(liveApi, org, threadId, secondId, "SCENARIO:simple"))
        .status,
    ).toBe(202);

    const first = await retry(async () => {
      const invocation = readInvocations(logPath)[0];
      if (
        !invocation ||
        invocation.scenario !== "fatalhang" ||
        invocation.ownership !== ownership
      ) {
        throw new Error("fatal-hanging harness has not started");
      }
      return invocation;
    }, RETRY_OPTIONS);
    cleanupProcesses.set(first.pid, { pid: first.pid, ownership });

    const invocations = await retry(async () => {
      const values = readInvocations(logPath);
      if (values.length !== 2) {
        throw new Error(
          `queued successor has not started: ${JSON.stringify(values)}`,
        );
      }
      return values;
    }, RETRY_OPTIONS);
    expect(invocations.map((entry) => entry.scenario)).toEqual([
      "fatalhang",
      "simple",
    ]);
    expect(
      processIsAlive(first.pid),
      "queued successor started before the fatal harness process was reaped",
    ).toBe(false);
    cleanupProcesses.delete(first.pid);
    expect(
      readJsonLines<StubSignal>(signalPath).some(
        (signal) => signal.pid === first.pid && signal.signal === "SIGTERM",
      ),
    ).toBe(true);

    const messages = await retry(async () => {
      const values = await listMessages(liveApi!, org, threadId);
      if (values.length !== 4) {
        throw new Error(`FIFO has not completed: ${JSON.stringify(values)}`);
      }
      return values;
    }, RETRY_OPTIONS);
    expect(messages.map(({ role, seq }) => ({ role, seq }))).toEqual([
      { role: "user", seq: 1 },
      { role: "assistant", seq: 2 },
      { role: "user", seq: 3 },
      { role: "assistant", seq: 4 },
    ]);
    expect(messages[0]?.id).toBe(firstId);
    expect(messages[2]?.id).toBe(secondId);
    expect(messages[1]?.id).toMatch(/^native-assistant:v1:[0-9a-f]{64}$/);
    expect(messages[3]?.id).toMatch(/^native-assistant:v1:[0-9a-f]{64}$/);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "SIGTERM cancels two independent queues concurrently and leaves no stub-harness child",
    async () => {
      const org = "queue-shutdown-org";
      const threads = ["queue-shutdown-thread-a", "queue-shutdown-thread-b"];

      const workdir = mkdtempSync(join(tmpdir(), "decopilot-queue-shutdown-"));
      cleanupDirs.add(workdir);
      const logPath = invocationLog(workdir);
      const signalPath = signalLog(workdir);
      const ownerships = threads.map(
        (_, index) => `queue-shutdown-${index}-${randomUUID()}`,
      );
      liveApi = await startAuthenticatedLocalApi(
        stubClaudeBinEnv({
          STUB_HARNESS_INVOCATION_LOG: logPath,
          STUB_HARNESS_SIGNAL_LOG: signalPath,
        }),
        { workdir },
      );

      for (const [index, threadId] of threads.entries()) {
        expect(
          await dispatchTurn(
            liveApi,
            org,
            threadId,
            `queue-shutdown-message-${index}`,
            `SCENARIO:termresist OWNERSHIP:${ownerships[index]}`,
          ).then((response) => response.status),
        ).toBe(202);
      }
      const children = await retry(async () => {
        const invocations = readInvocations(logPath).filter(
          (entry) =>
            entry.scenario === "termresist" &&
            ownerships.includes(entry.ownership ?? ""),
        );
        if (
          invocations.length !== 2 ||
          invocations.some((entry) => !processIsAlive(entry.pid))
        ) {
          throw new Error(
            `two hanging harness children are not alive yet: ${JSON.stringify(invocations)}`,
          );
        }
        return invocations;
      }, RETRY_OPTIONS);
      for (const child of children) {
        cleanupProcesses.set(child.pid, {
          pid: child.pid,
          ownership: child.ownership!,
        });
      }

      expect(liveApi.proc.kill("SIGTERM")).toBe(true);
      await waitForExit(liveApi);
      await retry(async () => {
        const alive = children.filter((child) => processIsAlive(child.pid));
        if (alive.length > 0) {
          throw new Error(
            `orphaned stub harnesses are still alive: ${JSON.stringify(alive)}`,
          );
        }
      }, RETRY_OPTIONS);
      for (const child of children) cleanupProcesses.delete(child.pid);

      const shutdownSignals = readJsonLines<StubSignal>(signalPath).filter(
        (signal) => children.some((child) => child.pid === signal.pid),
      );
      expect(shutdownSignals.length).toBe(2);
      const signalTimes = shutdownSignals.map(({ at }) => at);
      expect(
        Math.max(...signalTimes) - Math.min(...signalTimes),
        "queue cancellation was serialized across two one-second TERM grace periods",
      ).toBeLessThan(500);
    },
    30_000,
  );
});
