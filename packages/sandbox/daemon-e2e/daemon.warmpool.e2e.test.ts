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
  jsonAuthHeaders,
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

describe("daemon e2e: a second dev server is never spawned", () => {
  let d: Daemon;
  let repo: BareRepo;
  beforeEach(async () => {
    // A `dev` script that stays up, so the orchestrator's auto-start leaves a
    // live task behind — the state an agent walks into on a warmed pod.
    repo = setupBareRepo({
      withPackageJson: true,
      scripts: { dev: 'node -e "setInterval(() => {}, 1000)"' },
    });
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  it(
    "POST /exec/dev returns the running task instead of starting another",
    async () => {
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" } },
            env: {
              npm_config_audit: "false",
              npm_config_fund: "false",
              npm_config_offline: "true",
              npm_config_update_notifier: "false",
            },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const first = await fetch(url(d, "/_sandbox/exec/dev"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: "{}",
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        taskId: string;
        alreadyRunning?: boolean;
      };
      // Two Vite/Next builds on one pod's memory limit is how a warmed sandbox
      // OOMs itself, so this must NOT be a fresh spawn.
      expect(firstBody.alreadyRunning).toBe(true);

      // Idempotent: asking again keeps pointing at the same task.
      const second = await fetch(url(d, "/_sandbox/exec/dev"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: "{}",
      });
      const secondBody = (await second.json()) as {
        taskId: string;
        alreadyRunning?: boolean;
      };
      expect(secondBody.alreadyRunning).toBe(true);
      expect(secondBody.taskId).toBe(firstBody.taskId);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "a same-commit branch change keeps the running dev server",
    async () => {
      // The claim that binds a warm pool pod arrives as branch-change onto a
      // thread branch cut from the commit the pool warmed: the checkout leaves
      // the tree byte-identical. Restarting dev there rebuilds a framework that
      // was already serving — the pod stops being warm at the exact moment
      // someone asks for it.
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" } },
            env: { npm_config_offline: "true" },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const dev = async () =>
        (await (
          await fetch(url(d, "/_sandbox/exec/dev"), {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: "{}",
          })
        ).json()) as { taskId: string; alreadyRunning?: boolean };
      const warm = await dev();
      expect(warm.alreadyRunning).toBe(true);

      const res = await postConfig(d, {
        git: { repository: { cloneUrl: repo.url, branch: "thread-x" } },
      });
      expect(((await res.json()) as { transition: string }).transition).toBe(
        "branch-change",
      );
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const afterClaim = await dev();
      expect(afterClaim.alreadyRunning).toBe(true);
      expect(afterClaim.taskId).toBe(warm.taskId);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe("daemon e2e: a claim onto a serving pod keeps reporting running", () => {
  let d: Daemon;
  let repo: BareRepo;
  let devPort: number;
  beforeEach(async () => {
    devPort = await freePort();
    // A dev script that actually serves, so the daemon reaches `running` —
    // that is the state a warm pool pod is in when a claim arrives.
    repo = setupBareRepo({
      withPackageJson: true,
      scripts: {
        dev: `node -e "require('http').createServer((_q,s)=>{s.setHeader('content-type','text/html');s.end('<html>ok</html>')}).listen(process.env.PORT||3000)"`,
      },
    });
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  const lifecyclePhase = async (): Promise<string> => {
    // /_sandbox/events replays the current lifecycle state as its first frame.
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

  /** Poll until the prober has confirmed the server (bounded). */
  const waitForRunning = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await lifecyclePhase()) === "running") return;
    }
    throw new Error("lifecycle never reached running");
  };

  it(
    "reports running immediately, not starting, when the checkout spared the dev server",
    async () => {
      // `starting` is a lie when the process behind the port never stopped, and
      // Studio holds a full-canvas booting overlay over a live preview until the
      // prober re-confirms the server — 13-26s measured on a warm pool pod.
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" }, port: devPort },
            env: { npm_config_offline: "true" },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      await waitForRunning();

      const res = await postConfig(d, {
        git: { repository: { cloneUrl: repo.url, branch: "thread-x" } },
      });
      expect(((await res.json()) as { transition: string }).transition).toBe(
        "branch-change",
      );
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      // No sleep: the point is that this is true the moment the checkout ends,
      // without waiting on the prober.
      expect(await lifecyclePhase()).toBe("running");
    },
    SETUP_TIMEOUT_MS,
  );
});
