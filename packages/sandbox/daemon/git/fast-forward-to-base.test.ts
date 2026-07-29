import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastForwardToBase } from "./fast-forward-to-base";

const GITCFG =
  "-c init.defaultBranch=main -c user.email=test@example.com " +
  "-c user.name=test -c commit.gpgsign=false";
const GIT_OPTS = { stdio: "ignore" as const };

function git(cwd: string, cmd: string): void {
  execSync(`git ${GITCFG} -C ${cwd} ${cmd}`, GIT_OPTS);
}

function writeCommit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content, "utf-8");
  git(dir, "add .");
  git(dir, `commit -m "${msg}"`);
}

/**
 * Bare origin with `main` (2 commits) and a `feat/x` forked from main's FIRST
 * commit and pushed — i.e. behind main by one commit, no local commits of its
 * own. `workspace` is a clone of `feat/x`, the "idle sandbox".
 */
function setupBehindRepo(): {
  repoDir: string;
  bare: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "ff-to-base-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");

  execSync(`git ${GITCFG} init --bare ${bare}`, GIT_OPTS);
  execSync(`git ${GITCFG} init ${seed}`, GIT_OPTS);

  writeCommit(seed, "readme.md", "v1\n", "initial");
  git(seed, "branch -M main");
  git(seed, `remote add origin ${bare}`);
  git(seed, "push -u origin main");

  // Fork feat/x from main@v1 (no extra commits) and push it.
  git(seed, "checkout -b feat/x");
  git(seed, "push -u origin feat/x");

  // main moves on.
  git(seed, "checkout main");
  writeCommit(seed, "readme.md", "v2\n", "advance main");
  git(seed, "push origin main");

  const repoDir = join(root, "workspace");
  execSync(`git ${GITCFG} clone --branch feat/x ${bare} ${repoDir}`, GIT_OPTS);
  git(repoDir, "config user.email test@example.com");
  git(repoDir, "config user.name test");
  // `git clone` already sets origin/HEAD -> origin/main, which fastForwardToBase
  // reads to discover the base branch.

  return {
    repoDir,
    bare,
    cleanup: () => execSync(`rm -rf ${root}`, { stdio: "ignore" }),
  };
}

function headContent(repoDir: string, file: string): string {
  return execSync(`git ${GITCFG} -C ${repoDir} show HEAD:${file}`, {
    encoding: "utf-8",
  }).trim();
}

describe("fastForwardToBase", () => {
  it("fast-forwards a clean branch that is behind base and pushes", async () => {
    const { repoDir, bare, cleanup } = setupBehindRepo();
    try {
      const result = await fastForwardToBase(repoDir, { asUser: false });

      expect(result.fastForwarded).toBe(true);
      expect(result.base).toBe("main");
      expect(result.branch).toBe("feat/x");
      expect(result.aheadOfBase).toBe(0);
      expect(result.behindBase).toBe(1);
      expect(result.pushed).toBe(true);

      // Working tree now carries main's advance.
      expect(headContent(repoDir, "readme.md")).toBe("v2");

      // origin/feat/x advanced too (non-force push landed).
      const remoteFeat = execSync(
        `git ${GITCFG} -C ${repoDir} rev-parse origin/feat/x`,
        { encoding: "utf-8" },
      ).trim();
      const remoteMain = execSync(
        `git ${GITCFG} --git-dir=${bare} rev-parse main`,
        { encoding: "utf-8" },
      ).trim();
      expect(remoteFeat).toBe(remoteMain);
    } finally {
      cleanup();
    }
  });

  it("skips when the branch has local commits (diverged)", async () => {
    const { repoDir, cleanup } = setupBehindRepo();
    try {
      // Add a local commit → aheadOfBase becomes 1.
      writeCommit(repoDir, "local.txt", "mine\n", "local work");

      const result = await fastForwardToBase(repoDir, { asUser: false });

      expect(result.fastForwarded).toBe(false);
      expect(result.skipped).toBe("diverged");
      expect(result.aheadOfBase).toBe(1);
      // Untouched: still on the local commit, not main's v2.
      expect(headContent(repoDir, "readme.md")).toBe("v1");
    } finally {
      cleanup();
    }
  });

  it("skips when already up to date with base", async () => {
    const { repoDir, cleanup } = setupBehindRepo();
    try {
      // First call brings it up to date...
      await fastForwardToBase(repoDir, { asUser: false });
      // ...second call is a no-op.
      const result = await fastForwardToBase(repoDir, { asUser: false });

      expect(result.fastForwarded).toBe(false);
      expect(result.skipped).toBe("up-to-date");
      expect(result.behindBase).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("refuses to fast-forward a protected (default) branch", async () => {
    const { repoDir, cleanup } = setupBehindRepo();
    try {
      git(repoDir, "checkout main");
      const result = await fastForwardToBase(repoDir, { asUser: false });

      expect(result.fastForwarded).toBe(false);
      expect(result.skipped).toBe("protected-branch");
    } finally {
      cleanup();
    }
  });

  it("skips on a detached HEAD", async () => {
    const { repoDir, cleanup } = setupBehindRepo();
    try {
      git(repoDir, "checkout --detach HEAD");
      const result = await fastForwardToBase(repoDir, { asUser: false });

      expect(result.fastForwarded).toBe(false);
      expect(result.skipped).toBe("detached-head");
    } finally {
      cleanup();
    }
  });
});
