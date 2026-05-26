import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSetupStep } from "../setup/spawn-step";
import {
  resolveRemoteDefaultBranch,
  spawnCheckoutBranch,
} from "./checkout-branch";

function setupBareRepo(): { url: string; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "checkout-branch-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);
  writeFileSync(join(seed, "README.md"), "main\n");
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

function cloneWorkspace(url: string, root: string): string {
  const repoDir = join(root, "workspace");
  execSync(`git clone --depth 1 --branch feature/x ${url} ${repoDir}`, {
    stdio: "ignore",
  });
  return repoDir;
}

describe("resolveRemoteDefaultBranch", () => {
  it("reads origin/HEAD symref", () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      expect(resolveRemoteDefaultBranch(repoDir)).toBe("main");
    } finally {
      cleanup();
    }
  });
});

describe("spawnCheckoutBranch", () => {
  it("forks a new local branch from default, not from current HEAD", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      const gc = `git -C ${repoDir}`;
      const logs: string[] = [];

      await spawnCheckoutBranch({
        repoDir,
        branch: "deco/new-branch",
        gc,
        runStep: (cmd) => spawnSetupStep(cmd, () => {}),
        log: (msg) => logs.push(msg),
      });

      expect(
        execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
          .toString()
          .trim(),
      ).toBe("deco/new-branch");
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
      expect(logs.some((l) => l.includes("default branch 'main'"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("checks out an existing local branch when absent from remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      execSync(`git -C ${repoDir} checkout -b local-only`, { stdio: "ignore" });
      writeFileSync(join(repoDir, "local.txt"), "local\n");
      execSync(`git -C ${repoDir} add local.txt`, { stdio: "ignore" });
      execSync(`git -C ${repoDir} commit -m local`, { stdio: "ignore" });
      execSync(`git -C ${repoDir} checkout feature/x`, { stdio: "ignore" });

      const gc = `git -C ${repoDir}`;
      await spawnCheckoutBranch({
        repoDir,
        branch: "local-only",
        gc,
        runStep: (cmd) => spawnSetupStep(cmd, () => {}),
        log: () => {},
      });

      expect(existsSync(join(repoDir, "local.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);
});
