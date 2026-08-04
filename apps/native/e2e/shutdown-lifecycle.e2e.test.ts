/**
 * Black-box graceful-shutdown ownership contract for native local-api.
 *
 * This deliberately combines the lifecycle edges that previously failed only
 * when exercised together:
 *
 * - an authenticated, long-lived `/_sandbox/events` response is still open;
 * - a public background `/_sandbox/bash` task owns a TERM-resistant
 *   root -> child -> grandchild process tree in one independently anchored
 *   process group;
 * - the standalone binary receives a real SIGTERM;
 * - shutdown must close admission, deliver TERM, escalate to KILL, reap every
 *   descendant, end/abort the SSE response, and exit within one fixed bound;
 * - a new binary must immediately acquire the same app-root lock.
 *
 * The test imports no Rust/app implementation. Pid files are emitted by a
 * deterministic subprocess fixture solely so the operating system can be
 * queried after local-api itself is gone.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { retry, sleep } from "@decocms/shared/std";
import { afterEach, expect, it } from "bun:test";

import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  STANDALONE_TEST_ACCOUNT,
  startLocalApi,
  stopLocalApi,
  url,
  type LocalApi,
} from "./helpers";

type ProcessRole = "root" | "child" | "grandchild";

interface OwnedProcess {
  ownership: string;
  pid: number;
  role: ProcessRole;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/shutdown-process-tree.mjs", import.meta.url),
);
const PROCESS_ROLES: ProcessRole[] = ["root", "child", "grandchild"];
const SHUTDOWN_BOUND_MS = 15_000;
const RETRY_OPTIONS = {
  maxAttempts: 150,
  minTimeout: 20,
  maxTimeout: 100,
  jitter: 0,
} as const;

let firstApi: LocalApi | null = null;
let restartedApi: LocalApi | null = null;
let eventReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let workdir: string | null = null;
let ownership: string | null = null;
let pidDir: string | null = null;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

function processIsStillOwned({
  ownership: marker,
  pid,
}: OwnedProcess): boolean {
  return processIsAlive(pid) && processCommand(pid)?.includes(marker) === true;
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

function processGroup(pid: number): number | null {
  try {
    const raw = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readOwnedProcess(
  directory: string,
  marker: string,
  role: ProcessRole,
): OwnedProcess {
  const pid = Number(readFileSync(join(directory, `${role}.pid`), "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid ${role} pid: ${pid}`);
  }
  const command = processCommand(pid);
  if (!processIsAlive(pid) || !command?.includes(marker)) {
    throw new Error(
      `${role} is not alive with ownership ${marker}: pid=${pid} command=${command}`,
    );
  }
  return { ownership: marker, pid, role };
}

async function waitForOwnedTree(
  directory: string,
  marker: string,
): Promise<OwnedProcess[]> {
  return retry(
    async () =>
      PROCESS_ROLES.map((role) => readOwnedProcess(directory, marker, role)),
    RETRY_OPTIONS,
  );
}

function killIfStillOwned(owned: OwnedProcess): void {
  const { pid } = owned;
  if (!processIsStillOwned(owned)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function cleanupOwnedTree(): void {
  if (!pidDir || !ownership) return;
  // Descendant-first cleanup keeps a failing regression from briefly
  // orphaning the lower generations after their parent is killed.
  for (const role of [...PROCESS_ROLES].reverse()) {
    try {
      killIfStillOwned(readOwnedProcess(pidDir, ownership, role));
    } catch {
      // Missing/dead/mismatched means there is no still-owned process to kill.
    }
  }
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  deadlineMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => {
        throw new Error(
          `SSE predicate was not reached within ${deadlineMs}ms: ${text.slice(-500)}`,
        );
      }),
    ]);
    if (next.done) {
      throw new Error(
        `SSE ended before its predicate matched: ${text.slice(-500)}`,
      );
    }
    text += decoder.decode(next.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(`SSE predicate was not reached within ${deadlineMs}ms`);
}

async function waitForStreamClose(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const next = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => "TIMEOUT" as const),
      ]);
      if (next === "TIMEOUT") break;
      if (next.done) return;
    } catch {
      // A process exit may reset rather than cleanly finish the TCP stream;
      // either outcome proves the long-lived response no longer owns state.
      return;
    }
  }
  throw new Error(`SSE response remained open beyond ${deadlineMs}ms`);
}

async function waitForProcessExit(
  api: LocalApi,
  deadlineMs: number,
): Promise<void> {
  if (api.proc.exitCode !== null || api.proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      api.proc.once("exit", () => resolve());
    }),
    sleep(deadlineMs).then(() => {
      throw new Error(`local-api did not exit within ${deadlineMs}ms`);
    }),
  ]);
}

afterEach(async () => {
  try {
    await eventReader?.cancel();
  } catch {
    // Already closed by process shutdown.
  }
  eventReader = null;

  await stopLocalApi(restartedApi, { keepWorkdir: true });
  await stopLocalApi(firstApi, { keepWorkdir: true });
  restartedApi = null;
  firstApi = null;

  cleanupOwnedTree();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = null;
  ownership = null;
  pidDir = null;
}, HOOK_TIMEOUT_MS);

describeLocalApi("local-api e2e: integrated graceful shutdown", () => {
  it.skipIf(process.platform === "win32")(
    "SIGKILL relaunch stays pre-ready until the old task process group is gone",
    async () => {
      const api = await startLocalApi(
        { LOCAL_API_TOKEN_STORE: "memory" },
        STANDALONE_TEST_ACCOUNT,
      );
      firstApi = api;
      workdir = api.workdir;
      const marker = `native-crash-fence-${randomUUID()}`;
      ownership = marker;
      const treeDir = join(api.workdir, "crash-fence-tree");
      pidDir = treeDir;
      const command = [
        "exec",
        shellQuote(process.execPath),
        shellQuote(FIXTURE_PATH),
        "root",
        shellQuote(marker),
        shellQuote(treeDir),
      ].join(" ");
      const started = await fetch(url(api, "/_sandbox/bash"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          command,
          cwd: api.workdir,
          mode: "background",
          timeout: 300_000,
        }),
      });
      expect(started.status).toBe(200);
      const tree = await waitForOwnedTree(treeDir, marker);

      expect(api.proc.kill("SIGKILL")).toBe(true);
      await waitForProcessExit(api, SHUTDOWN_BOUND_MS);

      // Start immediately: do not grant the old watchdog a pre-relaunch grace
      // period. The main instance lock is already kernel-released, but the
      // child-lifetime shared fence must keep this promise unresolved until
      // every TERM-resistant group member has been KILLed and reaped.
      const relaunchOutcome = startLocalApi(
        { LOCAL_API_TOKEN_STORE: "memory" },
        { ...STANDALONE_TEST_ACCOUNT, workdir: api.workdir },
      ).then(
        (restarted) => {
          restartedApi = restarted;
          return { restarted } as const;
        },
        (error: unknown) => ({ error }) as const,
      );

      await sleep(100);
      expect(tree.some(processIsStillOwned)).toBe(true);
      expect(restartedApi).toBeNull();

      await retry(async () => {
        const alive = tree.filter(processIsStillOwned);
        if (alive.length > 0) {
          if (restartedApi !== null) {
            throw new Error(
              `replacement became ready beside old task owners: ${JSON.stringify(alive)}`,
            );
          }
          throw new Error(
            `old crash task tree is still being reaped: ${JSON.stringify(alive)}`,
          );
        }
      }, RETRY_OPTIONS);
      for (const role of PROCESS_ROLES) {
        expect(existsSync(join(treeDir, `${role}.term`))).toBe(true);
      }

      const outcome = await relaunchOutcome;
      if ("error" in outcome) throw outcome.error;
      expect((await fetch(url(outcome.restarted, "/health"))).status).toBe(200);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "reaps a TERM-resistant process group, closes an open SSE stream, and releases the same-root lock",
    async () => {
      const api = await startLocalApi(
        { LOCAL_API_TOKEN_STORE: "memory" },
        STANDALONE_TEST_ACCOUNT,
      );
      firstApi = api;
      const appRoot = api.workdir;
      workdir = appRoot;
      const marker = `native-shutdown-${randomUUID()}`;
      ownership = marker;
      const treeDir = join(appRoot, "shutdown-tree");
      pidDir = treeDir;

      const events = await fetch(url(api, "/_sandbox/events"), {
        headers: authHeaders(),
      });
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      eventReader = events.body!.getReader();
      await readSseUntil(
        eventReader,
        (text) => text.includes("event: lifecycle"),
        5_000,
      );

      const command = [
        "exec",
        shellQuote(process.execPath),
        shellQuote(FIXTURE_PATH),
        "root",
        shellQuote(marker),
        shellQuote(treeDir),
      ].join(" ");
      const startTask = await fetch(url(api, "/_sandbox/bash"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          command,
          cwd: appRoot,
          mode: "background",
          timeout: 300_000,
        }),
      });
      expect(startTask.status).toBe(200);
      const task = (await startTask.json()) as {
        status: string;
        taskId: string;
      };
      expect(task.status).toBe("running");
      expect(task.taskId.length).toBeGreaterThan(0);

      const tree = await waitForOwnedTree(treeDir, marker);
      const groups = tree.map(({ pid }) => processGroup(pid));
      const ownedGroup = groups[0];
      expect(ownedGroup).not.toBeNull();
      expect(
        groups.every((group) => group === ownedGroup),
        `fixture escaped its anchored process group: ${JSON.stringify({ tree, groups })}`,
      ).toBe(true);

      const listedTasks = await fetch(
        url(api, "/_sandbox/tasks?status=running"),
        { headers: authHeaders() },
      );
      expect(listedTasks.status).toBe(200);
      expect(
        ((await listedTasks.json()) as { tasks: Array<{ id: string }> }).tasks
          .map(({ id }) => id)
          .includes(task.taskId),
      ).toBe(true);

      const streamClose = waitForStreamClose(eventReader, SHUTDOWN_BOUND_MS);
      expect(api.proc.kill("SIGTERM")).toBe(true);
      await Promise.all([
        waitForProcessExit(api, SHUTDOWN_BOUND_MS),
        streamClose,
      ]);

      expect(api.proc.exitCode).toBe(0);
      expect(api.proc.signalCode).toBeNull();

      await retry(async () => {
        const alive = tree.filter(processIsStillOwned);
        if (alive.length > 0) {
          throw new Error(
            `shutdown left owned descendants alive: ${JSON.stringify(alive)}`,
          );
        }
      }, RETRY_OPTIONS);
      for (const role of PROCESS_ROLES) {
        expect(
          existsSync(join(treeDir, `${role}.term`)),
          `${role} never observed shutdown's SIGTERM before escalation`,
        ).toBe(true);
      }

      // The two axum serve tasks retain clones of the kernel instance lock.
      // A successful immediate restart proves the long-lived SSE task was
      // aborted/awaited and every lock owner was dropped before process exit.
      const restarted = await startLocalApi(
        { LOCAL_API_TOKEN_STORE: "memory" },
        { ...STANDALONE_TEST_ACCOUNT, workdir: appRoot },
      );
      restartedApi = restarted;
      expect(restarted.workdir).toBe(appRoot);
      const health = await fetch(url(restarted, "/health"));
      expect(health.status).toBe(200);
    },
    30_000,
  );
});
