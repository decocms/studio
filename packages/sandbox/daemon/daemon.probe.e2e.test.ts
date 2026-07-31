/**
 * Daemon conformance suite — HEALTH PROBE UNDER LOAD.
 *
 * Studio polls `GET /health` with a 500ms timeout
 * (`server/daemon-client.ts:HEALTH_PROBE_TIMEOUT_MS`) and treats a single miss
 * as a dead sandbox: it tears the pod down, which discards every uncommitted
 * change in the workspace. So probe latency is not a performance nicety — it is
 * the property that decides whether a user's work survives, and no
 * daemon-internal work may stall the handler.
 *
 * This drives the load through the daemon's own routes (a heavy `git status`
 * over thousands of untracked files, concurrent with the branch monitor's own
 * refresh of the same tree) and samples `/health` throughout, asserting the
 * worst sample stays inside the budget. The threshold is Studio's real one, not
 * a comfortable one — a test that passes at 5s would not prove anything about
 * the behavior that pages us.
 */
import { afterEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  type Daemon,
  bootstrapRepo,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

/** Studio's HEALTH_PROBE_TIMEOUT_MS — one miss tears the sandbox down. */
const PROBE_BUDGET_MS = 500;
const SAMPLE_INTERVAL_MS = 25;
const LOAD_FILES = 4000;
const TEST_TIMEOUT_MS = 120_000;

let d: Daemon | null = null;
let repo: BareRepo | null = null;

afterEach(async () => {
  await stopDaemon(d);
  d = null;
  repo?.cleanup();
  repo = null;
}, HOOK_TIMEOUT_MS);

/** One /health round trip, in ms. Throws if it does not answer 200. */
async function probeOnce(daemon: Daemon): Promise<number> {
  const started = performance.now();
  const res = await fetch(url(daemon, "/health"));
  const elapsed = performance.now() - started;
  if (!res.ok) throw new Error(`/health returned ${res.status}`);
  await res.text();
  return elapsed;
}

describe("daemon e2e: health probe under load", () => {
  it(
    "answers /health inside Studio's probe budget during heavy git work",
    async () => {
      repo = setupBareRepo();
      d = await startDaemon();
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      // A working tree big enough that `git status` and the dirty-baseline hash
      // are real work, created in one bash call so the daemon is not the one
      // paying for the setup.
      const seed = await fetch(url(d, "/_sandbox/bash"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          command: `mkdir -p load && i=0; while [ $i -lt ${LOAD_FILES} ]; do echo "line $i" > load/$i.txt; i=$((i+1)); done`,
        }),
      });
      expect(seed.status).toBe(200);

      // Hammer the git routes while sampling the probe. Both run against the same
      // tree, so the daemon is doing git work for essentially the whole window.
      let loading = true;
      const load = (async () => {
        while (loading) {
          await fetch(url(d!, "/_sandbox/git/status"), {
            headers: authHeaders(),
          }).then((r) => r.text());
        }
      })();

      const samples: number[] = [];
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        samples.push(await probeOnce(d));
        await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
      }
      loading = false;
      await load;

      const worst = Math.max(...samples);
      const over = samples.filter((s) => s > PROBE_BUDGET_MS).length;
      // Reported on failure: "how badly" matters when the answer is a teardown.
      expect({
        samples: samples.length,
        over,
        worstMs: Math.round(worst),
      }).toEqual({
        samples: samples.length,
        over: 0,
        worstMs: Math.round(worst),
      });
      expect(worst).toBeLessThan(PROBE_BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );
});
