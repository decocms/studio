/**
 * Shared harness for the daemon conformance e2e suite.
 *
 * Every assertion in `daemon.e2e.*.test.ts` is a BLACK-BOX HTTP/SSE contract.
 * A daemon reimplemented in any language passes the suite by honoring the env
 * startup contract (DAEMON_TOKEN / APP_ROOT / PROXY_PORT / DAEMON_BOOT_ID) and
 * the route contracts the tests assert — point `DAEMON_E2E_CMD` at the new
 * binary and nothing else changes.
 *
 * This file imports only `node:`/`bun:` builtins — zero coupling to the daemon
 * source, so it can drive a non-TS implementation just as well.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "bun:test";

const DAEMON_BUNDLE = join(import.meta.dir, "dist", "daemon.js");
const DAEMON_TOKEN = "t".repeat(32);

// CI cold-start of the daemon listener occasionally exceeds Bun's default 5s
// hook timeout under load. Each test spawns a fresh daemon, so give the hooks
// generous headroom.
export const HOOK_TIMEOUT_MS = 30_000;
const PORT_WAIT_TIMEOUT_MS = 20_000;

/**
 * Resolve the command used to spawn the daemon under test.
 *
 * `raw` unset/empty: run the bundled TS daemon under Bun. A reimplementation
 * sets `DAEMON_E2E_CMD` to its own argv — either a JSON array
 * (`["./target/release/daemon"]`, required when args contain spaces) or a
 * plain whitespace-separated string (`"bun /abs/daemon.js"`). Passed in rather
 * than defaulted so the "no override" case stays testable under a
 * DAEMON_E2E_CMD run.
 */
export function resolveDaemonCmd(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return ["bun", DAEMON_BUNDLE];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      if (parsed.length === 0) throw new Error("DAEMON_E2E_CMD is empty");
      return parsed;
    }
  } catch {
    /* not JSON — fall back to whitespace split */
  }
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0) throw new Error("DAEMON_E2E_CMD is empty");
  return parts;
}

const DAEMON_CMD = resolveDaemonCmd(process.env.DAEMON_E2E_CMD);

export interface Daemon {
  port: number;
  proc: ChildProcess;
  appDir: string;
  /** Captured stderr, for surfacing startup crashes in assertions. */
  stderr: { value: string };
  /** Captured stdout — the daemon's log/setup stream. */
  stdout: { value: string };
}

export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { Authorization: `Bearer ${DAEMON_TOKEN}`, ...extra };
}

export function jsonAuthHeaders(): Record<string, string> {
  return authHeaders({ "Content-Type": "application/json" });
}

/** Absolute URL for a path on the daemon under test. */
export function url(d: Daemon, path: string): string {
  return `http://localhost:${d.port}${path}`;
}

/**
 * Ask the OS for a free port via a transient bind on port 0 — far less flaky
 * than picking a random number in a fixed range.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("freePort: bad address")));
      }
    });
  });
}

async function waitForPort(
  port: number,
  proc: ChildProcess,
  stderrBuf: { value: string },
  timeoutMs = PORT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `daemon exited before /health responded (code=${proc.exitCode} signal=${proc.signalCode}) stderr=${stderrBuf.value.slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon did not listen on :${port} within ${timeoutMs}ms`);
}

export async function startDaemon(
  extraEnv: Record<string, string> = {},
): Promise<Daemon> {
  const appDir = mkdtempSync(join(tmpdir(), "daemon-e2e-"));
  const port = await freePort();
  const [cmd, ...args] = DAEMON_CMD;
  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildDaemonEnv(appDir, port, extraEnv),
  });
  const stderr = { value: "" };
  const stdout = { value: "" };
  proc.stdout?.on("data", (c) => {
    stdout.value += c.toString();
    process.stderr.write(`[daemon:out] ${c}`);
  });
  proc.stderr?.on("data", (c) => {
    stderr.value += c.toString();
    process.stderr.write(`[daemon:err] ${c}`);
  });
  await waitForPort(port, proc, stderr);
  return { port, proc, appDir, stderr, stdout };
}

export function buildDaemonEnv(
  appDir: string,
  port: number,
  extraEnv: Record<string, string> = {},
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnv,
    // The daemon's documented startup contract — a reimplementation must
    // honor exactly these. (Dead vars DEV_PORT / DAEMON_NO_AUTOSTART /
    // DAEMON_DROP_PRIVILEGES from the pre-state-machine daemon are gone.)
    DAEMON_TOKEN,
    DAEMON_BOOT_ID: `boot-${port}`,
    APP_ROOT: appDir,
    PROXY_PORT: String(port),
    ...extraEnv,
    // Conformance children are headless and must never touch a developer's
    // real credential store. The TS daemon ignores this local-api setting.
    LOCAL_API_TOKEN_STORE: "memory",
  };
}

export async function stopDaemon(d: Daemon | null): Promise<void> {
  if (!d) return;
  const { proc, appDir } = d;
  if (proc.exitCode === null && proc.signalCode === null) {
    // Wait for the OS to reap the process tree so its bound port and cwd are
    // released before the next startDaemon picks a fresh one. On Windows,
    // ChildProcess.kill() terminates only the Bun parent; an in-flight npm.cmd
    // child can survive and keep appDir locked. taskkill /T closes that tree.
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      if (process.platform === "win32" && proc.pid !== undefined) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(proc.pid), "/T", "/F"],
          { stdio: "ignore" },
        );
        const fallBackToParentKill = () => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill();
        };
        killer.once("error", fallBackToParentKill);
        killer.once("exit", fallBackToParentKill);
      } else {
        proc.kill("SIGKILL");
      }
    });
  }
  if (appDir) {
    // Windows releases executable/cwd handles asynchronously even after the
    // process exit event — the exit above is already awaited, so a handle
    // that lingers past the retry budget is kernel timing, not a live
    // process. Cleanup of a per-test temp dir must never replace the real
    // assertion result with an EBUSY, so exhausting the retries downgrades
    // to a warning and leaves the dir to the runner's temp reaper.
    try {
      await rm(appDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    } catch (err) {
      console.warn(`[daemon:e2e] leaking temp dir ${appDir}: ${err}`);
    }
  }
}

// --- SSE ---------------------------------------------------------------------

/**
 * Read an SSE stream until `predicate(accumulated)` is true, then abort.
 * Hard-bounded by a deadline timer that aborts the request — so even a stream
 * that emits no bytes and never closes (a `reader.read()` that would otherwise
 * hang) fails loudly within `deadlineMs` instead of stalling until Bun's global
 * timeout. Accumulates across chunks (event boundaries split arbitrarily).
 */
export async function readSseUntil(
  target: string,
  opts: {
    predicate: (acc: string) => boolean;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    deadlineMs?: number;
  },
): Promise<{ res: Response; text: string }> {
  const deadlineMs = opts.deadlineMs ?? 8000;
  const ctrl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let acc = "";
  let matched: Response | undefined;

  // Race the WHOLE operation (fetch + every read) against one deadline. Aborting
  // the fetch signal does NOT reliably reject an in-flight `reader.read()` (nor
  // a header-stalled `fetch`) in Bun, so the race — not the abort — is what
  // bounds a stream that emits nothing and never closes.
  const work = (async () => {
    const res = await fetch(target, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    });
    reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) return;
      acc += dec.decode(r.value, { stream: true });
      if (opts.predicate(acc)) {
        matched = res;
        return;
      }
    }
  })();
  // The leaked read rejects once we abort/cancel below — swallow it so it never
  // surfaces as an unhandled rejection after we've already timed out.
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), deadlineMs);
  });

  try {
    const outcome = await Promise.race([
      work.then(() => "DONE" as const),
      timeout,
    ]);
    if (outcome === "TIMEOUT") {
      throw new Error(
        `SSE stream did not match within ${deadlineMs}ms; last 500 chars:\n${acc.slice(-500)}`,
      );
    }
    if (matched) return { res: matched, text: acc };
    throw new Error(
      `SSE stream ended before predicate matched; last 500 chars:\n${acc.slice(-500)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    ctrl.abort();
    try {
      await reader?.cancel();
    } catch {
      /* already closed */
    }
  }
}

// --- Bootstrap ---------------------------------------------------------------

/** POST /_sandbox/config with a JSON patch. */
export async function postConfig(d: Daemon, patch: unknown): Promise<Response> {
  return fetch(url(d, "/_sandbox/config"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(patch),
  });
}

/** Bootstrap the daemon onto a repo (triggers clone). */
export async function bootstrapRepo(
  d: Daemon,
  cloneUrl: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return postConfig(d, {
    git: { repository: { cloneUrl } },
    ...extra,
  });
}

/**
 * Poll GET /health until the orchestrator queue drains (clone/install/start
 * finished). `file://` clones converge well under a second.
 */
export async function waitForOrchestratorIdle(
  d: Daemon,
  deadlineMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const res = await fetch(url(d, "/health"));
    if (res.ok) {
      const body = (await res.json()) as {
        orchestrator?: { running: boolean; pending: number };
      };
      last = body;
      const orch = body.orchestrator;
      if (orch && !orch.running && orch.pending === 0) return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `orchestrator did not go idle within ${deadlineMs}ms; last health=${JSON.stringify(last)}`,
  );
}

// --- Bare git repo fixture ---------------------------------------------------

export interface BareRepo {
  url: string;
  root: string;
  cleanup: () => void;
}

/**
 * Create a bare "origin" git repo (default branch `main`, one commit with
 * README.md) and return a `file://` clone URL. Hermetic — no network, no port.
 * Adapted from `setup/clone.test.ts`. With `withPackageJson`, the seed commit
 * also carries a package.json + lockfile exposing an `echo` script and empty
 * deps so `npm install --offline` is deterministic.
 */
export function setupBareRepo(
  opts: { withPackageJson?: boolean } = {},
): BareRepo {
  const root = mkdtempSync(join(tmpdir(), "daemon-e2e-repo-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const o = { stdio: "ignore" as const };
  const cfg =
    "-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false";
  execSync(`git ${cfg} init --bare ${bare}`, o);
  execSync(`git ${cfg} init ${seed}`, o);
  writeFileSync(join(seed, "README.md"), "hello\n");
  if (opts.withPackageJson) {
    const packageJson = {
      name: "fixture-app",
      version: "0.0.0",
      private: true,
      scripts: { echo: "node -e \"console.log('hi-from-echo')\"" },
    };
    writeFileSync(
      join(seed, "package.json"),
      JSON.stringify(packageJson, null, 2),
    );
    writeFileSync(
      join(seed, "package-lock.json"),
      JSON.stringify(
        {
          name: packageJson.name,
          version: packageJson.version,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: packageJson.name,
              version: packageJson.version,
            },
          },
        },
        null,
        2,
      ),
    );
  }
  execSync(`git ${cfg} -C ${seed} add .`, o);
  execSync(`git ${cfg} -C ${seed} commit -m initial`, o);
  execSync(`git ${cfg} -C ${seed} branch -M main`, o);
  execSync(`git ${cfg} -C ${seed} remote add origin ${bare}`, o);
  execSync(`git ${cfg} -C ${seed} push -u origin main`, o);
  execSync(`git ${cfg} -C ${bare} symbolic-ref HEAD refs/heads/main`, o);
  return {
    // `file://${bare}` is POSIX-only: on win32 `bare` is a backslash,
    // drive-lettered path (e.g. `D:\...\origin.git`), and naively prefixing
    // "file://" produces a URL git can't parse. `pathToFileURL` emits the
    // platform-correct form (`file:///D:/...` on win32, `file:///...` on
    // POSIX).
    url: pathToFileURL(bare).href,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Write a file into the daemon's repo via the black-box /write route. */
export async function writeRepoFile(
  d: Daemon,
  path: string,
  content: string,
): Promise<void> {
  const res = await fetch(url(d, "/_sandbox/write"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(200);
}
