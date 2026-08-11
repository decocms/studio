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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  freePort,
  readSseUntil,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;

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

  const lifecyclePhase = async (): Promise<string> => {
    const { text } = await readSseUntil(url(d, "/_sandbox/events"), {
      headers: authHeaders(),
      predicate: (acc) => acc.includes("event: lifecycle"),
    });
    return (
      (
        JSON.parse(
          /event: lifecycle\ndata: (.*)\n/.exec(text)?.[1] ?? "{}",
        ) as { state?: { phase?: string } }
      ).state?.phase ?? ""
    );
  };

  const waitForPhase = async (
    want: (phase: string) => boolean,
    label: string,
    deadlineMs = 25_000,
  ): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    let last = "";
    while (Date.now() < deadline) {
      last = await lifecyclePhase();
      if (want(last)) return;
    }
    throw new Error(`lifecycle never reached ${label} (last=${last})`);
  };

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
