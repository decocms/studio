import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// A working repo on a feature branch wired to a real bare `origin`, so the
// push path in publish() actually runs (the initRepo() tests have no remote and
// only assert the pre-push commit landed). Returns the branch already pushed to
// origin at its initial commit.
function initRepoWithRemote(): {
  appRoot: string;
  repoDir: string;
  bare: string;
  branch: string;
} {
  const appRoot = mkdtempSync(join(tmpdir(), "git-route-remote-"));
  const bare = join(appRoot, "origin.git");
  const repoDir = join(appRoot, "app");
  const branch = "feature/x";
  const g = (args: string[], cwd: string) =>
    gitSync(args, { cwd, asUser: false });

  g(["-c", "init.defaultBranch=main", "init", "--bare", bare], appRoot);
  mkdirSync(repoDir, { recursive: true });
  g(["-c", "init.defaultBranch=main", "init"], repoDir);
  g(["config", "user.email", "test@example.com"], repoDir);
  g(["config", "user.name", "Test"], repoDir);
  g(["config", "commit.gpgsign", "false"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  g(["add", "README.md"], repoDir);
  g(["commit", "-m", "init"], repoDir);
  g(["branch", "-M", "main"], repoDir);
  g(["remote", "add", "origin", bare], repoDir);
  g(["push", "-u", "origin", "main"], repoDir);
  g(["checkout", "-b", branch], repoDir);
  g(["push", "-u", "origin", branch], repoDir);
  return { appRoot, repoDir, bare, branch };
}

// Push a commit to origin/<branch> from a *separate* clone, so the sandbox repo
// (which never fetches) diverges from the true remote tip — the exact state that
// makes a plain `git push` fail with "fetch first".
function pushDivergentCommitToRemote(
  appRoot: string,
  bare: string,
  branch: string,
): void {
  const other = join(appRoot, "other");
  const g = (args: string[], cwd: string) =>
    gitSync(args, { cwd, asUser: false });
  g(["clone", "--branch", branch, bare, other], appRoot);
  g(["config", "user.email", "other@example.com"], other);
  g(["config", "user.name", "Other"], other);
  g(["config", "commit.gpgsign", "false"], other);
  writeFileSync(join(other, "OTHER.md"), "from another clone\n");
  g(["add", "OTHER.md"], other);
  g(["commit", "-m", "divergent commit on origin"], other);
  g(["push", "origin", branch], other);
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

  it("diff shows the original content for a renamed file, not null", async () => {
    const { appRoot, repoDir } = initRepo();
    gitSync(["mv", "README.md", "GUIDE.md"], { cwd: repoDir, asUser: false });
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diffs: Record<string, { from: string | null; to: string | null }>;
    };
    expect(body.diffs["GUIDE.md"]?.from).toContain("hello");
    expect(body.diffs["GUIDE.md"]?.to).toContain("hello");
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

  it("diff POST returns 400 (not 500) when the base branch isn't on origin", async () => {
    const { appRoot, repoDir } = initRepo();
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/diff", {
        method: "POST",
        body: JSON.stringify({ base: "does-not-exist" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Base branch 'does-not-exist' not found on origin",
    });
  });

  it("diff POST rejects an empty base string as invalid input", async () => {
    const { appRoot, repoDir } = initRepo();
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/diff", {
        method: "POST",
        body: JSON.stringify({ base: "" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "base is required when provided",
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

  it("publish route returns 409 (not 500) for a protected-branch refusal", async () => {
    const { appRoot, repoDir } = initRepo(); // initRepo checks out main
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "from main" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/protected branch "main"/);
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

  it("publish() refuses to commit an invalid decofile block and leaves HEAD untouched", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    // The block already exists and is tracked (git reports edits to individual
    // tracked files) — mirrors the real corruption, which mutated an existing
    // page block already in the working tree.
    mkdirSync(join(repoDir, ".deco", "blocks"), { recursive: true });
    const block = join(repoDir, ".deco", "blocks", "pages-home.json");
    writeFileSync(block, '{ "__resolveType": "site/pages/Home.tsx" }');
    gitSync(["add", "--", ".deco/blocks/pages-home.json"], {
      cwd: repoDir,
      asUser: false,
    });
    gitSync(["commit", "-m", "add block"], { cwd: repoDir, asUser: false });
    const headBefore = gitSync(["rev-parse", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    });
    // now corrupt it: the exact shape — a dangling key inside an array + brace
    writeFileSync(
      block,
      '{ "benefits": [ { "label": "x" }, "rule": { "a": 1 } } ]',
    );
    // a valid tracked change too — publish must block the WHOLE commit, not just
    // skip the bad file
    writeFileSync(join(repoDir, "README.md"), "changed\n");

    expect(() => publish({ appRoot, repoDir }, "shutdown sync")).toThrow(
      /Refusing to publish.*invalid JSON.*pages-home\.json/,
    );
    // nothing committed — HEAD is exactly where it was
    expect(
      gitSync(["rev-parse", "HEAD"], { cwd: repoDir, asUser: false }),
    ).toBe(headBefore);
  });

  it("publish() commits a valid decofile block", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    mkdirSync(join(repoDir, ".deco", "blocks"), { recursive: true });
    writeFileSync(
      join(repoDir, ".deco", "blocks", "pages-home.json"),
      '{\n  "__resolveType": "site/pages/Home.tsx"\n}',
    );
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
    expect(files).toContain(".deco/blocks/pages-home.json");
  });

  it("publish() commits a deleted block without trying to parse it", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    mkdirSync(join(repoDir, ".deco", "blocks"), { recursive: true });
    const rel = ".deco/blocks/pages-home.json";
    writeFileSync(join(repoDir, rel), '{ "a": 1 }');
    gitSync(["add", "--", rel], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add block"], { cwd: repoDir, asUser: false });
    // delete it — the guard must skip (read fails), not throw
    rmSync(join(repoDir, rel));
    try {
      publish({ appRoot, repoDir }, "shutdown sync");
    } catch {
      // expected: push fails without a remote; the commit lands first
    }
    const files = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(files).toContain(rel); // the deletion was committed
  });

  it("publish() validates every changed block, not just the first", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    mkdirSync(join(repoDir, ".deco", "blocks"), { recursive: true });
    const a = ".deco/blocks/a.json";
    const b = ".deco/blocks/b.json";
    writeFileSync(join(repoDir, a), '{ "a": 1 }');
    writeFileSync(join(repoDir, b), '{ "b": 2 }');
    gitSync(["add", "--", a, b], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add blocks"], { cwd: repoDir, asUser: false });
    // first stays valid, second is corrupted → error must point at the second
    writeFileSync(join(repoDir, b), "{ broken");
    expect(() => publish({ appRoot, repoDir }, "sync")).toThrow(/b\.json/);
  });

  it("publish() commits an invalid NON-block .json (out of scope) without throwing", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    // a plain .json outside .deco/blocks is not gated — invalid content is fine
    writeFileSync(join(repoDir, "data.json"), "{ not valid json");
    try {
      publish({ appRoot, repoDir }, "sync");
    } catch {
      // expected: push fails without a remote; the commit lands first
    }
    const files = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(files).toContain("data.json");
  });

  it("publish() with onInvalidBlock:skip syncs valid work and drops the bad block", () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    mkdirSync(join(repoDir, ".deco", "blocks"), { recursive: true });
    const block = ".deco/blocks/pages-home.json";
    writeFileSync(join(repoDir, block), '{ "__resolveType": "Home.tsx" }');
    gitSync(["add", "--", block], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add block"], { cwd: repoDir, asUser: false });
    // corrupt the block AND make a valid change elsewhere
    writeFileSync(join(repoDir, block), "{ broken");
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    // skip mode must NOT throw on the bad block
    try {
      publish({ appRoot, repoDir }, "shutdown sync", {
        onInvalidBlock: "skip",
      });
    } catch {
      // expected: push fails without a remote; the commit lands first
    }
    const files = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: repoDir,
      asUser: false,
    });
    expect(files).toContain("README.md"); // valid work synced
    expect(files).not.toContain(block); // corrupt block NOT committed
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

  it("publish route returns 409 (not 500) for a tokenless github origin", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    gitSync(["remote", "add", "origin", "https://github.com/owner/repo.git"], {
      cwd: repoDir,
      asUser: false,
    });
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "no creds" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/authenticated clone URL/);
  });

  it("publish route fast-forwards a normal (non-diverged) remote branch", async () => {
    const { appRoot, repoDir, bare, branch } = initRepoWithRemote();
    writeFileSync(join(repoDir, "README.md"), "ff change\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "ff publish" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pushed: boolean }).pushed).toBe(true);
    const remote = gitSync(["show", `refs/heads/${branch}:README.md`], {
      cwd: bare,
      asUser: false,
    });
    expect(remote).toContain("ff change");
  });

  it("publish route reconciles a diverged remote branch instead of failing 'fetch first'", async () => {
    const { appRoot, repoDir, bare, branch } = initRepoWithRemote();
    // origin/<branch> gains a commit the sandbox never saw → plain push rejects.
    pushDivergentCommitToRemote(appRoot, bare, branch);
    writeFileSync(join(repoDir, "README.md"), "sandbox change\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "publish from sandbox" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pushed: boolean }).pushed).toBe(true);
    // The sandbox's state won: origin/<branch> now carries its README and the
    // divergent commit was force-reconciled away.
    const readme = gitSync(["show", `refs/heads/${branch}:README.md`], {
      cwd: bare,
      asUser: false,
    });
    expect(readme).toContain("sandbox change");
    const tree = gitSync(["ls-tree", "--name-only", `refs/heads/${branch}`], {
      cwd: bare,
      asUser: false,
    });
    expect(tree).not.toContain("OTHER.md");
  });

  it("publish() (shutdown path) does NOT reconcile — it refuses to clobber a diverged remote", () => {
    const { appRoot, repoDir, bare, branch } = initRepoWithRemote();
    pushDivergentCommitToRemote(appRoot, bare, branch);
    writeFileSync(join(repoDir, "README.md"), "sandbox change\n");
    // Default opts → reconcileRemote off: the shutdown-sync contract must never
    // force-push over a concurrent sandbox's work.
    expect(() => publish({ appRoot, repoDir }, "shutdown sync")).toThrow();
    // origin/<branch> keeps the divergent commit — nothing was clobbered.
    const tree = gitSync(["ls-tree", "--name-only", `refs/heads/${branch}`], {
      cwd: bare,
      asUser: false,
    });
    expect(tree).toContain("OTHER.md");
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

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid path: ../outside-secret.txt",
    });
  });

  it("discard returns 400 (not 500) when filepaths contains a non-string entry", async () => {
    const { appRoot, repoDir } = initRepo();

    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: ["README.md", 123] }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "filepaths is required" });
  });

  it("discard returns 400 (not 500) when filepaths contains an empty string", async () => {
    const { appRoot, repoDir } = initRepo();

    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: [""] }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "filepaths is required" });
  });

  it("discard on a renamed file restores the original instead of deleting both", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "old.txt"), "important content\n");
    gitSync(["add", "old.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add old.txt"], { cwd: repoDir, asUser: false });
    gitSync(["mv", "old.txt", "new.txt"], { cwd: repoDir, asUser: false });

    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: ["new.txt"] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(existsSync(join(repoDir, "new.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "old.txt"))).toBe(true);
    expect(readFileSync(join(repoDir, "old.txt"), "utf8")).toBe(
      "important content\n",
    );
    expect(
      gitSync(["status", "--porcelain=v1"], {
        cwd: repoDir,
        asUser: false,
      }).trim(),
    ).toBe("");
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

  it("rebase route returns 400 (not 500) when the base branch isn't on origin", async () => {
    const { appRoot, repoDir } = initRepo();
    onFeatureBranch(repoDir);
    const bareOrigin = mkdtempSync(join(tmpdir(), "git-route-origin-"));
    gitSync(["init", "--bare", bareOrigin], { cwd: bareOrigin, asUser: false });
    gitSync(["remote", "add", "origin", bareOrigin], {
      cwd: repoDir,
      asUser: false,
    });
    gitSync(["push", "-u", "origin", "feature/x"], {
      cwd: repoDir,
      asUser: false,
    });

    const handler = makeGitRebaseHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/rebase", {
        method: "POST",
        body: JSON.stringify({ base: "does-not-exist" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Base branch 'does-not-exist' not found on origin",
    });
  });

  it("rebase route returns 409 (not 500) for a protected-branch refusal", async () => {
    const { appRoot, repoDir } = initRepo(); // initRepo checks out main
    const handler = makeGitRebaseHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/rebase", {
        method: "POST",
        body: JSON.stringify({ base: "main" }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/protected branch "main"/);
  });
});
