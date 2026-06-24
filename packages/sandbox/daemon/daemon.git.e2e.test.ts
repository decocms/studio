/**
 * Daemon conformance suite — GIT + EXEC + SETUP.
 *
 * These groups need a real cloned repo, so each test bootstraps the daemon
 * against a local bare git repo (file:// — hermetic, no network) and waits for
 * the setup orchestrator to drain. Black-box throughout (see helpers).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  postConfig,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
  writeRepoFile,
} from "./daemon.e2e.helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);
const SETUP_TIMEOUT_MS = 60_000;

// --- git: no repo cloned yet -------------------------------------------------

describe("daemon e2e: git (no repo)", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("GET /git/status before clone → 409 notReady", async () => {
    const res = await fetch(url(d, "/_sandbox/git/status"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { notReady: boolean };
    expect(body.notReady).toBe(true);
  });

  it("POST /git/diff before clone → 409 notReady", async () => {
    const res = await fetch(url(d, "/_sandbox/git/diff"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(409);
  });
});

// --- git: cloned repo --------------------------------------------------------

describe("daemon e2e: git (cloned repo)", () => {
  let d: Daemon;
  let repo: BareRepo;
  beforeEach(async () => {
    repo = setupBareRepo();
    d = await startDaemon();
    // Clone onto a feature branch (not the protected base `main`) so publish
    // can push; identity is required for publish()'s commit to succeed.
    const res = await postConfig(d, {
      git: {
        repository: { cloneUrl: repo.url, branch: "sandbox-work" },
        identity: { userName: "Test User", userEmail: "test@example.com" },
      },
    });
    expect(res.status).toBe(200);
    await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
  }, SETUP_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  it("GET /git/status reports the cloned branch", async () => {
    const res = await fetch(url(d, "/_sandbox/git/status"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: string | null;
      files: unknown[];
    };
    expect(body.current).toBe("sandbox-work");
    expect(Array.isArray(body.files)).toBe(true);
  });

  it("POST /git/diff surfaces an uncommitted new file", async () => {
    await writeRepoFile(d, "new-file.txt", "fresh\n");
    const res = await fetch(url(d, "/_sandbox/git/diff"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diffs: Record<string, unknown> };
    expect(Object.keys(body.diffs)).toContain("new-file.txt");
  });

  it("POST /git/discard with empty filepaths → 400", async () => {
    const res = await fetch(url(d, "/_sandbox/git/discard"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ filepaths: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /git/discard removes an untracked file", async () => {
    await writeRepoFile(d, "scratch.txt", "discard me\n");
    const res = await fetch(url(d, "/_sandbox/git/discard"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ filepaths: ["scratch.txt"] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });

  it("POST /git/rebase without a base → 400", async () => {
    const res = await fetch(url(d, "/_sandbox/git/rebase"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("POST /git/publish commits + pushes to the file:// origin", async () => {
    await writeRepoFile(d, "published.txt", "ship it\n");
    const res = await fetch(url(d, "/_sandbox/git/publish"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ message: "test publish" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pushed: boolean }).pushed).toBe(true);
  });
});

// --- setup routes ------------------------------------------------------------

describe("daemon e2e: setup routes", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  for (const step of ["clone", "install", "start"] as const) {
    it(`POST /setup/${step} → { enqueued: "${step}" }`, async () => {
      const res = await fetch(url(d, `/_sandbox/setup/${step}`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enqueued: string }).enqueued).toBe(step);
    });
  }
});

// --- exec --------------------------------------------------------------------

describe("daemon e2e: exec", () => {
  it(
    "POST /exec/<script> before any application config → 409",
    async () => {
      const d = await startDaemon();
      try {
        const res = await fetch(url(d, "/_sandbox/exec/echo"), {
          method: "POST",
          headers: authHeaders(),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("POST /config first");
      } finally {
        await stopDaemon(d);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  describe("with a configured application", () => {
    let d: Daemon;
    let repo: BareRepo;
    beforeEach(async () => {
      repo = setupBareRepo({ withPackageJson: true });
      d = await startDaemon();
      // Bootstrap clone + npm package manager so scripts are discoverable.
      expect(
        (
          await bootstrapRepo(d, repo.url, {
            application: { packageManager: { name: "npm" } },
          })
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
    }, SETUP_TIMEOUT_MS);
    afterEach(async () => {
      await stopDaemon(d);
      repo.cleanup();
    }, HOOK_TIMEOUT_MS);

    it(
      "runs a discovered script in await mode and returns its output",
      async () => {
        const res = await fetch(url(d, "/_sandbox/exec/echo"), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: toBody({ mode: "await" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          exitCode: number;
          stdout: string;
          taskId: string;
        };
        expect(body.exitCode).toBe(0);
        expect(body.stdout).toContain("hi-from-echo");
      },
      SETUP_TIMEOUT_MS,
    );

    it("unknown script → 404 with the available list", async () => {
      const res = await fetch(url(d, "/_sandbox/exec/nope"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: toBody({ mode: "await" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; available: string[] };
      expect(body.error).toContain("not found");
      expect(body.available).toContain("echo");
    });

    it("POST /exec/<script>/kill returns a killed count", async () => {
      const res = await fetch(url(d, "/_sandbox/exec/echo/kill"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      // killByLogName returns the number of matching tasks killed.
      expect(typeof ((await res.json()) as { killed: number }).killed).toBe(
        "number",
      );
    });
  });
});
