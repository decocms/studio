import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { gitSync } from "../git/git-sync";
import {
  computeDiffAgainstBase,
  makeGitDiffHandler,
  makeGitDiscardHandler,
  makeGitPublishHandler,
  makeGitRebaseHandler,
  makeGitStatusHandler,
  publish,
} from "./git";

function initRepo(): { appRoot: string; repoDir: string } {
  const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
  const repoDir = join(appRoot, "app");
  mkdirSync(repoDir, { recursive: true });
  gitSync(["init", "-b", "main"], { cwd: repoDir, asUser: false });
  gitSync(["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    asUser: false,
  });
  gitSync(["config", "user.name", "Test"], { cwd: repoDir, asUser: false });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  gitSync(["add", "README.md"], { cwd: repoDir, asUser: false });
  gitSync(["commit", "-m", "init"], { cwd: repoDir, asUser: false });
  return { appRoot, repoDir };
}

// publish() refuses to push from a protected branch (main/master/default), so
// tests that exercise the commit/push path must move onto a feature branch first.
function onFeatureBranch(repoDir: string): void {
  gitSync(["checkout", "-b", "feature/x"], { cwd: repoDir, asUser: false });
}

describe("git routes", () => {
  it("status reports modified files", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitStatusHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modified: string[] };
    expect(body.modified).toContain("README.md");
  });

  it("status returns 409 notReady before the repo is cloned", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    const handler = makeGitStatusHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "repository not initialized",
      notReady: true,
    });
  });

  it("diff returns 409 notReady before the repo is cloned", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/diff"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "repository not initialized",
      notReady: true,
    });
  });

  it("publish returns 409 notReady before the repo is cloned", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "test" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "repository not initialized",
      notReady: true,
    });
  });

  it("discard returns 409 notReady before the repo is cloned", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: ["README.md"] }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "repository not initialized",
      notReady: true,
    });
  });

  it("rebase returns 409 notReady before the repo is cloned", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    const handler = makeGitRebaseHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/rebase", {
        method: "POST",
        body: JSON.stringify({ base: "main" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "repository not initialized",
      notReady: true,
    });
  });

  it("status reports unpushed when feature branch has no remote ref", async () => {
    const { appRoot, repoDir } = initRepo();
    gitSync(["checkout", "-b", "deco/thin-crane"], {
      cwd: repoDir,
      asUser: false,
    });
    writeFileSync(join(repoDir, "feature.txt"), "x\n");
    gitSync(["add", "feature.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "feature"], { cwd: repoDir, asUser: false });
    const mainSha = gitSync(["rev-parse", "main"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/main", mainSha], {
      cwd: repoDir,
      asUser: false,
    });

    const handler = makeGitStatusHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aheadOfBase: number;
      unpushed: number;
      tracking: string | null;
      current: string | null;
    };
    expect(body.current).toBe("deco/thin-crane");
    expect(body.tracking).toBeNull();
    expect(body.aheadOfBase).toBe(1);
    expect(body.unpushed).toBe(1);
  });

  it("status reports aheadOfBase on a feature branch", async () => {
    const { appRoot, repoDir } = initRepo();
    gitSync(["checkout", "-b", "feat/test"], { cwd: repoDir, asUser: false });
    writeFileSync(join(repoDir, "feature.txt"), "x\n");
    gitSync(["add", "feature.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "feature"], { cwd: repoDir, asUser: false });
    const mainSha = gitSync(["rev-parse", "main"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/main", mainSha], {
      cwd: repoDir,
      asUser: false,
    });
    const featureSha = gitSync(["rev-parse", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/feat/test", featureSha], {
      cwd: repoDir,
      asUser: false,
    });

    const handler = makeGitStatusHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aheadOfBase: number;
      base: string;
      current: string | null;
    };
    expect(body.current).toBe("feat/test");
    expect(body.base).toBe("main");
    expect(body.aheadOfBase).toBeGreaterThan(0);
  });

  it("diff returns before/after content", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diffs: Record<string, { from: string | null; to: string | null }>;
    };
    expect(body.diffs["README.md"]?.from).toContain("hello");
    expect(body.diffs["README.md"]?.to).toContain("hello world");
  });

  it("diff against base returns committed branch changes", async () => {
    const { appRoot, repoDir } = initRepo();
    gitSync(["checkout", "-b", "feature"], { cwd: repoDir, asUser: false });
    writeFileSync(join(repoDir, "feature.txt"), "on branch\n");
    gitSync(["add", "feature.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add feature file"], {
      cwd: repoDir,
      asUser: false,
    });
    const mainSha = gitSync(["rev-parse", "main"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/main", mainSha], {
      cwd: repoDir,
      asUser: false,
    });
    const featureSha = gitSync(["rev-parse", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", `refs/remotes/origin/feature`, featureSha], {
      cwd: repoDir,
      asUser: false,
    });

    const prDiff = await computeDiffAgainstBase(repoDir, "main");
    expect(Object.keys(prDiff.diffs)).toContain("feature.txt");
    expect(prDiff.diffs["feature.txt"]?.from).toBeNull();
    expect(prDiff.diffs["feature.txt"]?.to).toContain("on branch");

    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/diff", {
        method: "POST",
        body: JSON.stringify({ base: "main" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diffs: Record<string, { from: string | null; to: string | null }>;
    };
    expect(body.diffs["feature.txt"]?.to).toContain("on branch");
  });

  it("diff against base honors headSha when set", async () => {
    const { repoDir } = initRepo();
    gitSync(["checkout", "-b", "feature"], { cwd: repoDir, asUser: false });
    writeFileSync(join(repoDir, "feature.txt"), "v1\n");
    gitSync(["add", "feature.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "v1"], { cwd: repoDir, asUser: false });
    const firstSha = gitSync(["rev-parse", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    }).trim();

    writeFileSync(join(repoDir, "feature.txt"), "v2\n");
    gitSync(["add", "feature.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "v2"], { cwd: repoDir, asUser: false });

    const mainSha = gitSync(["rev-parse", "main"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/main", mainSha], {
      cwd: repoDir,
      asUser: false,
    });
    const featureSha = gitSync(["rev-parse", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    }).trim();
    gitSync(["update-ref", "refs/remotes/origin/feature", featureSha], {
      cwd: repoDir,
      asUser: false,
    });

    const pinned = await computeDiffAgainstBase(repoDir, "main", firstSha);
    expect(pinned.diffs["feature.txt"]?.to).toContain("v1");
    expect(pinned.diffs["feature.txt"]?.to).not.toContain("v2");
  });

  it("diff POST rejects invalid base branch names", async () => {
    const { appRoot, repoDir } = initRepo();
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/diff", {
        method: "POST",
        body: JSON.stringify({ base: "--upload-pack=evil" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid base branch name: --upload-pack=evil",
    });
  });

  it("publish appends operator co-author trailer", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    writeFileSync(join(repoDir, "README.md"), "updated\n");
    const handler = makeGitPublishHandler({
      appRoot,
      repoDir,
      getOperator: () => ({
        userName: "Studio User",
        userEmail: "studio@example.com",
      }),
    });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "update readme" }),
      }),
    );
    expect([200, 500]).toContain(res.status);
    const log = gitSync(["log", "-1", "--pretty=%B"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(log).toContain("Co-authored-by: Studio User <studio@example.com>");
  });

  it("publish commits staged changes", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    writeFileSync(join(repoDir, "README.md"), "updated\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "update readme" }),
      }),
    );
    // No remote configured in this fixture — push fails, but commit should land.
    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("update readme");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("publish() skips cleanly on a never-cloned dir (shutdown path)", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
    const repoDir = join(appRoot, "app");
    mkdirSync(repoDir, { recursive: true });
    // The shutdown handler calls publish() directly, bypassing the handler's
    // isGitRepo() guard — it must not throw "not a git repository".
    expect(publish({ appRoot, repoDir }, "shutdown sync")).toEqual({
      pushed: false,
    });
  });

  it("publish() refuses to push to a protected branch (main)", () => {
    const { appRoot, repoDir } = initRepo(); // initRepo checks out main
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    expect(() => publish({ appRoot, repoDir }, "shutdown sync")).toThrow(
      /protected branch "main"/,
    );
    // Nothing was committed on main — the guard fires before add/commit.
    const log = gitSync(["log", "-1", "--pretty=%s"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(log.trim()).toBe("init");
  });

  it("publish() does not commit org-fs mount content excluded via .git/info/exclude", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir); // publish() refuses the protected default branch
    // Simulate the org-fs mount landing inside the working tree (org/…), as it
    // did on the deco-sites farm repo. gitSetup registers `/org` at boot.
    mkdirSync(join(repoDir, ".git", "info"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "info", "exclude"), "/org\n");
    mkdirSync(join(repoDir, "org", "home", "pages"), { recursive: true });
    writeFileSync(
      join(repoDir, "org", "home", "pages", "ver27-performance.html"),
      "<html></html>\n",
    );
    // A real tracked change so the commit isn't empty.
    writeFileSync(join(repoDir, "README.md"), "changed\n");

    // No remote configured → the push throws, but the commit lands first.
    try {
      publish({ appRoot, repoDir }, "shutdown sync");
    } catch {
      // expected: push fails without a remote
    }

    const files = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(files).toContain("README.md");
    expect(files).not.toContain("ver27-performance.html");
    expect(files).not.toContain("org/");
  });

  it("publish() rejects a tokenless github origin with a clear error", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    gitSync(["remote", "add", "origin", "https://github.com/owner/repo.git"], {
      cwd: repoDir,
      asUser: false,
    });
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    expect(() => publish({ appRoot, repoDir }, "no creds")).toThrow(
      /authenticated clone URL/,
    );
  });

  it("publish skips failing pre-commit hooks", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    const hooksDir = join(repoDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repoDir, "README.md"), "hook-bypass\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "skip hooks" }),
      }),
    );

    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("skip hooks");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("publish stages only paths with working tree changes", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    writeFileSync(join(repoDir, "tracked.txt"), "original\n");
    gitSync(["add", "tracked.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add tracked"], { cwd: repoDir, asUser: false });

    writeFileSync(join(repoDir, "README.md"), "updated\n");

    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "only readme" }),
      }),
    );

    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("only readme");
      const show = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(show.trim()).toBe("README.md");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("discard rejects path traversal", async () => {
    const { appRoot, repoDir } = initRepo();
    const outside = join(dirname(appRoot), "outside-secret.txt");
    writeFileSync(outside, "secret\n");

    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: ["../outside-secret.txt"] }),
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Invalid path: ../outside-secret.txt",
    });
  });

  it("rebase rejects invalid base branch names", async () => {
    const { appRoot, repoDir } = initRepo();
    const handler = makeGitRebaseHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/rebase", {
        method: "POST",
        body: JSON.stringify({ base: "--upload-pack=evil" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid base branch name: --upload-pack=evil",
    });
  });
});
