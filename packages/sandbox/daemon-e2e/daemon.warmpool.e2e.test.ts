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

  it(
    "a same-repo branch change after bootstrap does not reinstall",
    async () => {
      // This is the whole point of a warm pool: the claim that binds a pool pod
      // switches it to the thread's branch, and the deps the pool paid for must
      // survive that. If they don't, a warm pod is just a cold pod with extra
      // steps.
      const withDeps = setupBareRepo({ withPackageJson: true });
      try {
        expect((await bootstrapRepo(d, withDeps.url)).status).toBe(200);
        await waitForOrchestratorIdle(d);
        expect(d.stdout.value).toContain("installing dependencies");

        const before = d.stdout.value.length;
        const res = await postConfig(d, {
          git: { repository: { cloneUrl: withDeps.url, branch: "thread-x" } },
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { transition: string }).transition).toBe(
          "branch-change",
        );
        await waitForOrchestratorIdle(d);

        const since = d.stdout.value.slice(before);
        expect(since).toContain("running step: clone");
        expect(since).not.toContain("installing dependencies");
      } finally {
        withDeps.cleanup();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "a different-repo config is refused, so a pod can't be repurposed",
    async () => {
      // Why pools are keyed (org, repo): a pod prewarmed on repo A can never
      // serve a claim for repo B. The claim falls back to a cold pod instead of
      // silently getting someone else's checkout.
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      const other = setupBareRepo();
      try {
        const res = await postConfig(d, {
          git: { repository: { cloneUrl: other.url } },
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await res.text()).toContain("cloneUrl");
      } finally {
        other.cleanup();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});
