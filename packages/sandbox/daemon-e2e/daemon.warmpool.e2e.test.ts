/**
 * Daemon conformance suite — TENANT WARM POOL.
 *
 * A tenant pool bootstraps its pods with an identity-less config: repo +
 * workload, no user. The pod must stay `claimed:false` so the housekeeper's
 * idle sweep leaves it alone until someone actually claims it. Black-box
 * throughout (see helpers).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  postConfig,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;

async function idle(d: Daemon): Promise<{
  claimed: boolean;
  prewarmed: boolean;
}> {
  const res = await fetch(url(d, "/_sandbox/idle"), { headers: authHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()) as { claimed: boolean; prewarmed: boolean };
}

describe("daemon e2e: tenant warm pool", () => {
  let d: Daemon;
  let repo: BareRepo;
  beforeEach(async () => {
    repo = setupBareRepo();
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  it(
    "identity-less bootstrap leaves claimed:false, prewarmed:true",
    async () => {
      expect((await idle(d)).claimed).toBe(false);

      // Exactly what the pool reconciler sends: repo + workload, no author.
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      expect(await idle(d)).toMatchObject({ claimed: false, prewarmed: true });
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "a later identity-bearing config flips claimed:true",
    async () => {
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);
      expect((await idle(d)).claimed).toBe(false);

      const res = await postConfig(d, {
        git: {
          repository: { cloneUrl: repo.url },
          identity: { userName: "Ada", userEmail: "ada@example.com" },
        },
      });
      expect(res.status).toBe(200);

      expect((await idle(d)).claimed).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "an env-only change after bootstrap restarts the dev server",
    async () => {
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      const before = d.stdout.value.length;
      const res = await postConfig(d, { env: { FEATURE_FLAG: "on" } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { transition: string }).transition).toBe(
        "env-change",
      );
      await waitForOrchestratorIdle(d);

      // Without env-change → start, the new env would sit in the store and
      // never reach the dev server: the orchestrator would run no step at all.
      expect(d.stdout.value.slice(before)).toContain("running step: start");
    },
    SETUP_TIMEOUT_MS,
  );
});
