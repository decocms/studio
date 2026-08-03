/**
 * Daemon conformance suite — GIT + EXEC + SETUP.
 *
 * These groups need a real cloned repo, so each test bootstraps the daemon
 * against a local bare git repo (file:// — hermetic, no network) and waits for
 * the setup orchestrator to drain. Black-box throughout (see helpers).
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

  it("POST /git/publish pushes past a failing pre-push hook", async () => {
    // A repo's own pre-push hook must never block the sync: the shutdown
    // publish shares this path and can't wait out a hanging/failing hook before
    // the pod's grace period elapses and SIGKILL drops the unsynced work. The
    // push runs --no-verify, so a hook that would abort the push is skipped.
    const hook = join(d.appDir, "repo", ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    await writeRepoFile(d, "past-hook.txt", "survived the hook\n");
    const res = await fetch(url(d, "/_sandbox/git/publish"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ message: "publish past a failing hook" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pushed: boolean }).pushed).toBe(true);
  });

  // A single malformed `.deco/blocks/*.json` breaks the whole site render, so
  // both the byte-level write paths and publish refuse to let one through.
  const BLOCK = ".deco/blocks/pages-home.json";
  const blockPath = () => join(d.appDir, "repo", ".deco", "blocks");

  it("POST /write refuses an invalid decofile block", async () => {
    const res = await fetch(url(d, "/_sandbox/write"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: BLOCK, content: '{ "bad": ' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Refusing to write",
    );
    expect(existsSync(join(blockPath(), "pages-home.json"))).toBe(false);
  });

  it("POST /write accepts a valid decofile block", async () => {
    await writeRepoFile(d, BLOCK, '{"__resolveType":"home"}');
    expect(readFileSync(join(blockPath(), "pages-home.json"), "utf8")).toBe(
      '{"__resolveType":"home"}',
    );
  });

  it("POST /edit refuses an edit that would invalidate a block", async () => {
    await writeRepoFile(d, BLOCK, '{"a":1}');
    const res = await fetch(url(d, "/_sandbox/edit"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        path: BLOCK,
        old_string: '{"a":1}',
        new_string: '{"a":1',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Refusing to write",
    );
    // The rejected edit left the file untouched, not half-applied.
    expect(readFileSync(join(blockPath(), "pages-home.json"), "utf8")).toBe(
      '{"a":1}',
    );
  });

  it("POST /edit allows an edit that keeps a block valid", async () => {
    await writeRepoFile(d, BLOCK, '{"a":1}');
    const res = await fetch(url(d, "/_sandbox/edit"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        path: BLOCK,
        old_string: '{"a":1}',
        new_string: '{"a":2}',
      }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(blockPath(), "pages-home.json"), "utf8")).toBe(
      '{"a":2}',
    );
  });

  it("POST /git/publish refuses to commit an invalid block", async () => {
    // Bypass /write the way bash or a git merge would.
    mkdirSync(blockPath(), { recursive: true });
    writeFileSync(join(blockPath(), "pages-home.json"), '{ "bad": ');
    const res = await fetch(url(d, "/_sandbox/git/publish"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ message: "should not land" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Refusing to publish",
    );
  });

  // Windows Node can't deliver a catchable SIGTERM — kill("SIGTERM") tears the
  // process down abruptly, so the shutdown handler never runs. Graceful
  // termination is a POSIX/k8s concern (the daemon runs on Linux in prod).
  it.skipIf(process.platform === "win32")(
    "SIGTERM triggers a graceful publish to origin before exit",
    async () => {
      await writeRepoFile(d, "graceful.txt", "saved on shutdown\n");

      // origin has no `sandbox-work` branch until the shutdown publish pushes.
      const remoteRef = () =>
        execSync(`git ls-remote ${repo.url} refs/heads/sandbox-work`, {
          encoding: "utf8",
        }).trim();
      expect(remoteRef()).toBe("");

      // Real OS signal — the same SIGTERM k8s delivers on a spot drain / node
      // eviction (~120s grace). shutdown() must commit + push before exit(0),
      // or the user's in-progress work dies with the pod.
      const start = Date.now();
      const exited = new Promise<void>((resolve) =>
        d.proc.once("exit", () => resolve()),
      );
      d.proc.kill("SIGTERM");
      await exited;
      const elapsedMs = Date.now() - start;

      // Well under the graceful-termination budget; a local push is ~instant.
      expect(elapsedMs).toBeLessThan(30_000);
      // The change reached origin — work survived the pod dying.
      expect(remoteRef()).not.toBe("");
    },
    SETUP_TIMEOUT_MS,
  );

  // Shutdown sync uses the "skip" disposition: aborting the whole commit over
  // one bad block would silently lose every OTHER change when the pod dies.
  it.skipIf(process.platform === "win32")(
    "SIGTERM skips an invalid block but still syncs the rest",
    async () => {
      await writeRepoFile(d, "valid-work.txt", "must survive\n");
      mkdirSync(blockPath(), { recursive: true });
      writeFileSync(join(blockPath(), "pages-home.json"), '{ "bad": ');

      const exited = new Promise<void>((resolve) =>
        d.proc.once("exit", () => resolve()),
      );
      d.proc.kill("SIGTERM");
      await exited;

      const bare = join(repo.root, "origin.git");
      const tracked = execSync(
        `git -C ${bare} ls-tree -r --name-only refs/heads/sandbox-work`,
        { encoding: "utf8" },
      );
      expect(tracked).toContain("valid-work.txt");
      expect(tracked).not.toContain(BLOCK);
    },
    SETUP_TIMEOUT_MS,
  );
});

// --- git: branch names are argv, never shell ---------------------------------

// git permits `;`, `$` and backticks in ref names, and the branch is
// config-supplied. Daemon-owned git steps must spawn argv so a crafted name is
// a (rejected) branch name, never a command.
describe("daemon e2e: git (branch name is not a shell string)", () => {
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
    "a branch name carrying a shell payload never executes it",
    async () => {
      const canary = join(d.appDir, "pwned");
      const res = await postConfig(d, {
        git: {
          repository: {
            cloneUrl: repo.url,
            branch: `evil;touch ${canary};echo `,
          },
          identity: { userName: "Test User", userEmail: "test@example.com" },
        },
      });
      // Rejecting at config validation (400) and accepting-then-refusing the
      // clone are both fine. The payload running is not.
      expect([200, 400]).toContain(res.status);
      if (res.status === 200)
        await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      expect(existsSync(canary)).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );
});

// --- git: diverged origin + fast-forward -------------------------------------

describe("daemon e2e: git (diverged origin)", () => {
  let d: Daemon;
  let repo: BareRepo;
  const bare = () => join(repo.root, "origin.git");

  // Push a commit to origin/<branch> from a throwaway clone, so the sandbox's
  // local branch is no longer a fast-forward of the remote.
  const divergeOrigin = (branch: string, file: string) => {
    const side = join(repo.root, `side-${file}`);
    const cfg =
      "-c user.email=other@example.com -c user.name=other -c commit.gpgsign=false";
    execSync(`git ${cfg} clone ${repo.url} ${side}`, { stdio: "ignore" });
    execSync(`git ${cfg} -C ${side} checkout -B ${branch}`, {
      stdio: "ignore",
    });
    writeFileSync(join(side, file), "from another writer\n");
    execSync(`git ${cfg} -C ${side} add .`, { stdio: "ignore" });
    execSync(`git ${cfg} -C ${side} commit -m "${file}"`, { stdio: "ignore" });
    execSync(`git ${cfg} -C ${side} push -f origin ${branch}`, {
      stdio: "ignore",
    });
  };

  beforeEach(async () => {
    repo = setupBareRepo();
    d = await startDaemon();
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

  it(
    "interactive publish reconciles a diverged origin/<branch>",
    async () => {
      // Land a first publish so origin/sandbox-work exists...
      await writeRepoFile(d, "first.txt", "one\n");
      expect(
        (
          await fetch(url(d, "/_sandbox/git/publish"), {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: toBody({ message: "first" }),
          })
        ).status,
      ).toBe(200);

      // ...then rewrite it from outside, so a plain push would be rejected.
      divergeOrigin("sandbox-work", "outsider.txt");

      await writeRepoFile(d, "second.txt", "two\n");
      const res = await fetch(url(d, "/_sandbox/git/publish"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: toBody({ message: "second" }),
      });
      expect(res.status).toBe(200);

      // The sandbox's state won — that is what "reconcile" means here.
      const tracked = execSync(
        `git -C ${bare()} ls-tree -r --name-only refs/heads/sandbox-work`,
        { encoding: "utf8" },
      );
      expect(tracked).toContain("second.txt");
      expect(tracked).not.toContain("outsider.txt");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "re-bootstrap fast-forwards an idle branch to a moved base",
    async () => {
      // The sandbox has no local commits; base moves on while it sits idle.
      divergeOrigin("main", "moved-base.txt");

      const res = await fetch(url(d, "/_sandbox/setup/clone"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const repoDir = join(d.appDir, "repo");
      const tracked = execSync(`git -C ${repoDir} ls-files`, {
        encoding: "utf8",
      });
      expect(tracked).toContain("moved-base.txt");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "shutdown sync does NOT reconcile — it must never clobber",
    async () => {
      await writeRepoFile(d, "first.txt", "one\n");
      expect(
        (
          await fetch(url(d, "/_sandbox/git/publish"), {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: toBody({ message: "first" }),
          })
        ).status,
      ).toBe(200);
      divergeOrigin("sandbox-work", "outsider.txt");

      await writeRepoFile(d, "on-shutdown.txt", "late\n");
      const exited = new Promise<void>((resolve) =>
        d.proc.once("exit", () => resolve()),
      );
      d.proc.kill("SIGTERM");
      await exited;

      // The other writer's commit survives: a stale teardown must not
      // force-push over a concurrent sandbox's work.
      const tracked = execSync(
        `git -C ${bare()} ls-tree -r --name-only refs/heads/sandbox-work`,
        { encoding: "utf8" },
      );
      expect(tracked).toContain("outsider.txt");
    },
    SETUP_TIMEOUT_MS,
  );
});

// --- git: protected branch ---------------------------------------------------

// publish pushes --no-verify, which skips the pre-push hook entirely, so this
// in-code guard is the only thing between a sandbox and a push to main.
describe("daemon e2e: git (protected branch)", () => {
  let d: Daemon;
  let repo: BareRepo;
  beforeEach(async () => {
    repo = setupBareRepo();
    d = await startDaemon();
    const res = await postConfig(d, {
      git: {
        repository: { cloneUrl: repo.url, branch: "main" },
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

  it(
    "POST /git/publish on main → 409 and creates no commit",
    async () => {
      const repoDir = join(d.appDir, "repo");
      const headBefore = execSync(`git -C ${repoDir} rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();

      await writeRepoFile(d, "sneaky.txt", "should not land on main\n");
      const res = await fetch(url(d, "/_sandbox/git/publish"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: toBody({ message: "straight to main" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(
        "protected branch",
      );

      // The refusal fires before the commit — no stray commit is left behind.
      expect(
        execSync(`git -C ${repoDir} rev-parse HEAD`, {
          encoding: "utf8",
        }).trim(),
      ).toBe(headBefore);
      expect(
        execSync(`git -C ${repoDir} status --porcelain`, { encoding: "utf8" }),
      ).toContain("sneaky.txt");
    },
    SETUP_TIMEOUT_MS,
  );
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
            // The exec contract needs a discovered npm script, not registry
            // access. Keep this empty fixture hermetic: npm otherwise performs
            // first-run audit/update checks that intermittently wait on the
            // registry for the entire Windows hook timeout.
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
