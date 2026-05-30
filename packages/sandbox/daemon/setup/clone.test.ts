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
import type { Config } from "../types";
import { spawnClone } from "./clone";

/**
 * Creates a bare "origin" git repo with two branches:
 *   - main      → contains README.md
 *   - feature/x → contains README.md + feature.txt (branched from main+1)
 *
 * Returned `url` is a `file://` URL safe to use as a clone source.
 */
function setupBareRepo(): { url: string; root: string; cleanup: () => void } {
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
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function currentBranch(repoDir: string): string {
  return execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
    .toString()
    .trim();
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
