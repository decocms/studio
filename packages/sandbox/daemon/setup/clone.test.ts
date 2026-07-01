import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBranchDivergence } from "../git/branch-divergence";
import type { Config } from "../types";
import { isSafeRefName, spawnClone } from "./clone";

/**
 * Creates a bare "origin" git repo with two branches:
 *   - main      → contains README.md
 *   - feature/x → contains README.md + feature.txt (branched from main+1)
 *
 * Returned `url` is a `file://` URL safe to use as a clone source.
 */
function setupBareRepo(): {
  url: string;
  root: string;
  bare: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "clonetest-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);
  writeFileSync(join(seed, "README.md"), "hello\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} checkout -b feature/x`, gitOpts);
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m feature`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push origin feature/x`, gitOpts);
  // Make `main` the default branch the bare repo's HEAD points at, so a clone
  // without --branch lands on main.
  execSync(
    `git ${gitcfg} -C ${bare} symbolic-ref HEAD refs/heads/main`,
    gitOpts,
  );
  return {
    url: `file://${bare}`,
    root,
    bare,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function currentBranch(repoDir: string): string {
  return execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
    .toString()
    .trim();
}

/** Run a git command, returning trimmed stdout or null on non-zero exit. */
function tryGitOut(repoDir: string, args: string): string | null {
  try {
    return execSync(`git -C ${repoDir} ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function makeConfig(
  repoDir: string,
  cloneUrl: string,
  branch?: string,
): Config {
  return {
    git: {
      repository: { cloneUrl, ...(branch ? { branch } : {}) },
    },
    application: {},
    repoDir,
  } as unknown as Config;
}

describe("isSafeRefName", () => {
  it("accepts real branch names", () => {
    for (const name of [
      "main",
      "master",
      "feature/x",
      "release/1.0",
      "feat-2.0_a",
      "user/fix.bug",
    ]) {
      expect(isSafeRefName(name)).toBe(true);
    }
  });

  it("rejects shell metacharacters and ref-format edge cases", () => {
    for (const name of [
      "x;whoami",
      "a$(id)b",
      "a`id`b",
      "a|b",
      "a&b",
      "a>b",
      "a b",
      "-x",
      "/x",
      "x/",
      "a..b",
      "a//b",
      "x.lock",
      "",
    ]) {
      expect(isSafeRefName(name)).toBe(false);
    }
  });
});

describe("spawnClone", () => {
  it("clones the target branch directly when it exists on remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("feature/x");
      // The clone landed on feature/x — the file unique to that branch is present.
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("fetches the base branch so divergence vs base is computable (case 2)", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      // Even though only feature/x was cloned, origin/main must be present with
      // origin/HEAD pointing at it — otherwise computeBranchDivergence can't
      // compute ahead/behind vs base and the header falsely shows "Up to date".
      // Assert the two artifacts fetchBaseBranch produces directly, so a
      // regression that drops the fetch or the symbolic-ref step is caught
      // (aheadOfBase alone would survive it via the "main" default fallback).
      expect(
        tryGitOut(
          repoDir,
          "rev-parse --verify --quiet refs/remotes/origin/main",
        ),
      ).toBeTruthy();
      expect(
        tryGitOut(repoDir, "symbolic-ref --short refs/remotes/origin/HEAD"),
      ).toBe("origin/main");
      const div = computeBranchDivergence(repoDir);
      expect(div.base).toBe("main");
      // feature/x has a commit that main does not — the button gates on
      // aheadOfBase > 0. (Exact counts are approximate on shallow clones and
      // not asserted; they aren't surfaced in the UI.)
      expect(div.aheadOfBase).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("does not re-fetch the base when resuming the default branch itself", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      // Resuming `main` (the default) hits the `base === branchOnRemote` skip:
      // the base is already the cloned branch, so no second fetch is needed.
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "main"),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("main");
      const div = computeBranchDivergence(repoDir);
      expect(div.base).toBe("main");
      expect(div.aheadOfBase).toBe(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("refuses a maliciously named default branch instead of running it", async () => {
    const { url, root, cleanup, bare } = setupBareRepo();
    try {
      // Git permits `;`/`$()`/backticks in ref names; the default branch name
      // flows into `sh -c` git commands, so an unsafe name must be rejected
      // before interpolation rather than executed.
      const evil = "x;whoami";
      const mainSha = execSync(`git -C ${bare} rev-parse refs/heads/main`)
        .toString()
        .trim();
      execSync(`git -C ${bare} branch '${evil}' ${mainSha}`, {
        stdio: "ignore",
      });
      execSync(`git -C ${bare} symbolic-ref HEAD 'refs/heads/${evil}'`, {
        stdio: "ignore",
      });

      const repoDir = join(root, "workspace");
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        onChunk: () => {},
      });
      // Best-effort: the clone still succeeds; it just skips the unsafe base.
      expect(code).toBe(0);
      // origin/HEAD must NOT have been pointed at the malicious ref.
      expect(
        tryGitOut(repoDir, "symbolic-ref --short refs/remotes/origin/HEAD"),
      ).not.toBe(`origin/${evil}`);
      expect(
        tryGitOut(
          repoDir,
          `rev-parse --verify --quiet 'refs/remotes/origin/${evil}'`,
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones default and forks a local branch when target is missing on remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "feature/new"),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      // Local branch was created from default (main); feature/x's exclusive
      // file should NOT be present, README.md (from main) should be.
      expect(currentBranch(repoDir)).toBe("feature/new");
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones the default branch when no branch is specified", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const code = await spawnClone({
        config: makeConfig(repoDir, url),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("main");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("fails with a non-zero exit when ls-remote cannot reach the remote", async () => {
    const { root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      // file:// URL pointing at a path that doesn't exist — ls-remote returns
      // a fatal error (not exit 2), so spawnClone must surface a non-zero
      // exit code instead of silently falling through to a local fork.
      const code = await spawnClone({
        config: makeConfig(
          repoDir,
          "file:///nonexistent/path/to/repo.git",
          "feature/x",
        ),
        onChunk: () => {},
      });
      expect(code).not.toBe(0);
      expect(existsSync(repoDir)).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones into a non-empty dir without .git via init+fetch", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      mkdirSync(repoDir);
      // Pre-populate with a non-.git file — mimics .decocms/daemon.json being
      // written before the first clone. spawnClone must fall back to
      // init + fetch + checkout instead of `git clone`.
      writeFileSync(join(repoDir, "marker.txt"), "preexisting\n");
      const code = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("feature/x");
      expect(existsSync(join(repoDir, "marker.txt"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);
});
