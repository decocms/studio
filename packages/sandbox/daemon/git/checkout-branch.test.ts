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
import { InvalidRemoteBranchNameError } from "./ref-name";

/** `runGit` fake wired to the real `git -C <repoDir>` invocation for e2e-style tests. */
function makeRunGit(repoDir: string) {
  return (args: readonly string[]) =>
    spawnSetupStep({ argv: ["git", ...args], cwd: repoDir }, () => {});
}

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
  const gitcfg = `-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  execSync(
    `git ${gitcfg} clone --depth 1 --branch feature/x ${url} ${repoDir}`,
    {
      stdio: "ignore",
    },
  );
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
  it("forks a new local branch from main, not from current HEAD", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      const logs: string[] = [];

      await spawnCheckoutBranch({
        repoDir,
        branch: "deco/new-branch",
        runGit: makeRunGit(repoDir),
        log: (msg) => logs.push(msg),
      });

      expect(
        execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
          .toString()
          .trim(),
      ).toBe("deco/new-branch");
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
      expect(logs.some((l) => l.includes("base branch 'main'"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("checks out an existing local branch when absent from remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    const gitcfg = `-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
    try {
      const repoDir = cloneWorkspace(url, root);
      execSync(`git ${gitcfg} -C ${repoDir} checkout -b local-only`, {
        stdio: "ignore",
      });
      writeFileSync(join(repoDir, "local.txt"), "local\n");
      execSync(`git ${gitcfg} -C ${repoDir} add local.txt`, {
        stdio: "ignore",
      });
      execSync(`git ${gitcfg} -C ${repoDir} commit -m local`, {
        stdio: "ignore",
      });
      execSync(`git ${gitcfg} -C ${repoDir} checkout feature/x`, {
        stdio: "ignore",
      });

      await spawnCheckoutBranch({
        repoDir,
        branch: "local-only",
        runGit: makeRunGit(repoDir),
        log: () => {},
      });

      expect(existsSync(join(repoDir, "local.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("ignores origin/HEAD when creating a branch from main", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      // The remote default is deliberately irrelevant to sandbox branch
      // creation: a missing branch always forks from the fixed main base.
      execSync(
        `git -C ${repoDir} symbolic-ref refs/remotes/origin/HEAD 'refs/heads/pwn;touch\${IFS}${root}/INJECTED'`,
      );

      await spawnCheckoutBranch({
        repoDir,
        branch: "does-not-exist-anywhere",
        runGit: makeRunGit(repoDir),
        log: () => {},
      });

      expect(existsSync(join(root, "INJECTED"))).toBe(false);
      expect(
        execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
          .toString()
          .trim(),
      ).toBe("does-not-exist-anywhere");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("rejects a malicious requested branch instead of shelling it out", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = cloneWorkspace(url, root);
      // `branch` comes from the sandbox's git config and flows into git argv
      // (ls-remote/fetch/checkout) — argv form rules out shell injection, but
      // `assertValidRemoteBranchName` should still reject this before it ever
      // reaches a git invocation.
      await expect(
        spawnCheckoutBranch({
          repoDir,
          branch: `pwn;touch\${IFS}${root}/INJECTED`,
          runGit: makeRunGit(repoDir),
          log: () => {},
        }),
      ).rejects.toThrow(InvalidRemoteBranchNameError);

      expect(existsSync(join(root, "INJECTED"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);
});

/** Minimal non-bare repo — just enough for the HEAD/show-ref checks that run outside `runGit`. */
function setupLocalRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "checkout-branch-argv-"));
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  execSync(`git ${gitcfg} init ${repoDir}`, { stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "hi\n");
  execSync(`git ${gitcfg} -C ${repoDir} add .`, { stdio: "ignore" });
  execSync(`git ${gitcfg} -C ${repoDir} commit -m initial`, {
    stdio: "ignore",
  });
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

describe("spawnCheckoutBranch argv contract", () => {
  it("issues exact argv for the branch-on-remote path", async () => {
    const { repoDir, cleanup } = setupLocalRepo();
    try {
      const calls: string[][] = [];
      const runGit = async (args: readonly string[]) => {
        calls.push([...args]);
        return 0; // ls-remote, fetch, checkout all succeed
      };

      await spawnCheckoutBranch({
        repoDir,
        branch: "my-branch",
        runGit,
        log: () => {},
      });

      expect(calls).toEqual([
        ["ls-remote", "--exit-code", "--heads", "origin", "my-branch"],
        [
          "fetch",
          "--depth",
          "1",
          "origin",
          "+refs/heads/my-branch:refs/remotes/origin/my-branch",
        ],
        ["checkout", "-B", "my-branch", "refs/remotes/origin/my-branch"],
      ]);
    } finally {
      cleanup();
    }
  });

  it("issues exact argv for the local-only branch path", async () => {
    const { repoDir, cleanup } = setupLocalRepo();
    try {
      execSync(`git -C ${repoDir} branch local-only`, { stdio: "ignore" });
      const calls: string[][] = [];
      const runGit = async (args: readonly string[]) => {
        calls.push([...args]);
        return args[0] === "ls-remote" ? 2 : 0;
      };

      await spawnCheckoutBranch({
        repoDir,
        branch: "local-only",
        runGit,
        log: () => {},
      });

      expect(calls).toEqual([
        ["ls-remote", "--exit-code", "--heads", "origin", "local-only"],
        ["checkout", "local-only"],
      ]);
    } finally {
      cleanup();
    }
  });

  it("issues exact argv for the default-branch fork path", async () => {
    const { repoDir, cleanup } = setupLocalRepo();
    try {
      const calls: string[][] = [];
      const runGit = async (args: readonly string[]) => {
        calls.push([...args]);
        return args[0] === "ls-remote" ? 2 : 0;
      };

      await spawnCheckoutBranch({
        repoDir,
        branch: "brand-new",
        runGit,
        log: () => {},
      });

      expect(calls).toEqual([
        ["ls-remote", "--exit-code", "--heads", "origin", "brand-new"],
        [
          "fetch",
          "--depth",
          "1",
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        ],
        ["checkout", "-B", "brand-new", "refs/remotes/origin/main"],
      ]);
    } finally {
      cleanup();
    }
  });
});
