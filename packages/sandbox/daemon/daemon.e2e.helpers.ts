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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Default (`DAEMON_E2E_CMD` unset): run the bundled TS daemon under Bun. A
 * reimplementation sets `DAEMON_E2E_CMD` to its own argv — either a JSON array
 * (`["./target/release/daemon"]`, required when args contain spaces) or a
 * plain whitespace-separated string (`"bun /abs/daemon.js"`).
 */
export function resolveDaemonCmd(raw = process.env.DAEMON_E2E_CMD): string[] {
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

const DAEMON_CMD = resolveDaemonCmd();

export interface Daemon {
  port: number;
  proc: ChildProcess;
  appDir: string;
  /** Captured stderr, for surfacing startup crashes in assertions. */
  stderr: { value: string };
}

export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { Authorization: `Bearer ${DAEMON_TOKEN}`, ...extra };
}

export function jsonAuthHeaders(): Record<string, string> {
  return authHeaders({ "Content-Type": "application/json" });
}

/** Base URL for a daemon's sandbox routes. `prefix` defaults to legacy. */
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
    env: {
      ...process.env,
      // The daemon's documented startup contract — a reimplementation must
      // honor exactly these. (Dead vars DEV_PORT / DAEMON_NO_AUTOSTART /
      // DAEMON_DROP_PRIVILEGES from the pre-state-machine daemon are gone.)
      DAEMON_TOKEN,
      DAEMON_BOOT_ID: `boot-${port}`,
      APP_ROOT: appDir,
      PROXY_PORT: String(port),
      ...extraEnv,
    },
  });
  const stderr = { value: "" };
  proc.stdout?.on("data", (c) => process.stderr.write(`[daemon:out] ${c}`));
  proc.stderr?.on("data", (c) => {
    stderr.value += c.toString();
    process.stderr.write(`[daemon:err] ${c}`);
  });
  await waitForPort(port, proc, stderr);
  return { port, proc, appDir, stderr };
}

export async function stopDaemon(d: Daemon | null): Promise<void> {
  if (!d) return;
  const { proc, appDir } = d;
  if (proc.exitCode === null && proc.signalCode === null) {
    // Wait for the OS to reap the process so its bound port is released before
    // the next startDaemon picks a fresh one.
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGKILL");
    });
  }
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}

// --- SSE ---------------------------------------------------------------------

/**
 * Read an SSE stream until `predicate(accumulated)` is true, then abort. Always
 * bounded by a deadline so a stream that never satisfies the predicate fails
 * loudly instead of hanging the suite. Accumulates across chunks (event
 * boundaries split arbitrarily).
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
  const ctrl = new AbortController();
  const res = await fetch(target, {
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + (opts.deadlineMs ?? 8000);
  try {
    while (Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      acc += dec.decode(r.value, { stream: true });
      if (opts.predicate(acc)) return { res, text: acc };
    }
  } finally {
    ctrl.abort();
  }
  throw new Error(`SSE deadline reached; last 500 chars:\n${acc.slice(-500)}`);
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
 * also carries a package.json exposing an `echo` script and empty deps so
 * `npm install` is offline-safe.
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
    writeFileSync(
      join(seed, "package.json"),
      JSON.stringify(
        {
          name: "fixture-app",
          version: "0.0.0",
          private: true,
          scripts: { echo: "node -e \"console.log('hi-from-echo')\"" },
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
    url: `file://${bare}`,
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
