/**
 * Daemon conformance suite — DEV-SERVER LIVENESS WATCHDOG.
 *
 * When the dev server dies out from under a live daemon (idle freeze, crash, a
 * stale port after a reclaim), nothing used to respawn it: the proxy served
 * "Server is starting…" forever and the preview never came back. The daemon now
 * watches liveness and respawns a dead-but-known-port dev server, bounded, then
 * surfaces a real start-failed if it can't stay up.
 *
 * Black-box: we drive a real `dev` HTTP server, kill it over the wire, and
 * assert the daemon brings it back to `running` on its own. The watchdog's
 * grace/tick are shrunk via env so the test doesn't wait the 20s default.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  freePort,
  postConfig,
  readSseUntil,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;

const lifecyclePhaseOf = async (d: Daemon): Promise<string> => {
  const { text } = await readSseUntil(url(d, "/_sandbox/events"), {
    headers: authHeaders(),
    predicate: (acc) => acc.includes("event: lifecycle"),
  });
  return (
    (
      JSON.parse(/event: lifecycle\ndata: (.*)\n/.exec(text)?.[1] ?? "{}") as {
        state?: { phase?: string };
      }
    ).state?.phase ?? ""
  );
};

const waitForPhaseOf = async (
  d: Daemon,
  want: (phase: string) => boolean,
  label: string,
  deadlineMs = 25_000,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await lifecyclePhaseOf(d);
    if (want(last)) return;
  }
  throw new Error(`lifecycle never reached ${label} (last=${last})`);
};

describe("daemon e2e: dev-server liveness watchdog", () => {
  let d: Daemon;
  let repo: BareRepo;
  let devPort: number;

  beforeEach(async () => {
    devPort = await freePort();
    // A dev server that actually serves HTML, so the daemon reaches `running`.
    repo = setupBareRepo({
      withPackageJson: true,
      scripts: {
        dev: `node -e "require('http').createServer((_q,s)=>{s.setHeader('content-type','text/html');s.end('<html>ok</html>')}).listen(process.env.PORT||3000)"`,
      },
    });
    // Shrink the probe cadence and watchdog windows so a dead dev server is
    // detected and respawned in a couple of seconds instead of the 30s slow
    // probe + 20s production grace.
    d = await startDaemon({
      SANDBOX_PROBE_FAST_MS: "300",
      SANDBOX_PROBE_SLOW_MS: "1000",
      SANDBOX_DEV_WATCH_GRACE_MS: "1000",
      SANDBOX_DEV_WATCH_TICK_MS: "500",
    });
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  const waitForPhase = (
    want: (phase: string) => boolean,
    label: string,
    deadlineMs = 25_000,
  ) => waitForPhaseOf(d, want, label, deadlineMs);

  const waitForRunning = (deadlineMs = 25_000) =>
    waitForPhase((p) => p === "running", "running", deadlineMs);

  it(
    "respawns the dev server after it dies, returning to running",
    async () => {
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" }, port: devPort },
            env: { npm_config_offline: "true", PORT: String(devPort) },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      await waitForRunning();

      // Kill the dev server over the wire — nothing else respawns it, so a
      // return to `running` proves the watchdog restarted it.
      const killed = await fetch(url(d, "/_sandbox/exec/dev/kill"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(killed.status).toBe(200);

      // Observe the death first (the probe marks it crashed) so the subsequent
      // recovery to `running` is unambiguously the watchdog, not a stale frame.
      await waitForPhase((p) => p !== "running", "not-running");
      await waitForRunning();
      expect(d.stdout.value).toContain("restarting (attempt 1/");
    },
    SETUP_TIMEOUT_MS,
  );
});

// Fix #2: a dev server that crashed (non-zero exit) latches `status:"error"` +
// `start-failed`; a later reclaim/branch-change must clear that latch so the
// start step runs again — without it, `stepStartInner` silently skips every
// start and the sandbox stays start-failed forever. The watchdog cannot help
// here (start-failed is not a restartable phase), so this exercises the
// orchestrator's clearCrashError path specifically.
describe("daemon e2e: reclaim clears a latched dev-crash error", () => {
  let d: Daemon;
  let repo: BareRepo;
  let devPort: number;
  let marker: string;

  beforeEach(async () => {
    devPort = await freePort();
    marker = join(tmpdir(), `devwatch-reclaim-${devPort}`);
    rmSync(marker, { force: true });
    // The dev script exits 1 on its first run (creating the marker) and serves
    // on every run after — so the first start crashes (→ start-failed + error
    // latch) and a restarted start succeeds, isolating the latch-clear.
    repo = setupBareRepo({
      withPackageJson: true,
      scripts: {
        dev: `node -e "const fs=require('fs'),m='${marker.replace(/\\/g, "\\\\")}';if(!fs.existsSync(m)){fs.writeFileSync(m,'1');process.exit(1)}require('http').createServer((_q,s)=>{s.setHeader('content-type','text/html');s.end('<html>ok</html>')}).listen(process.env.PORT)"`,
      },
    });
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
    rmSync(marker, { force: true });
  }, HOOK_TIMEOUT_MS);

  it(
    "a branch-change after a crash restarts the dev server",
    async () => {
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" }, port: devPort },
            env: { npm_config_offline: "true", PORT: String(devPort) },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      // First start crashed → terminal start-failed with the error latched.
      await waitForPhaseOf(d, (p) => p === "start-failed", "start-failed");

      // A branch-change reclaim. Without clearCrashError the start step is
      // skipped (status still "error") and this stays start-failed.
      const res = await postConfig(d, {
        git: { repository: { cloneUrl: repo.url, branch: "thread-x" } },
      });
      expect(((await res.json()) as { transition: string }).transition).toBe(
        "branch-change",
      );
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      await waitForPhaseOf(d, (p) => p === "running", "running");
    },
    SETUP_TIMEOUT_MS,
  );
});
