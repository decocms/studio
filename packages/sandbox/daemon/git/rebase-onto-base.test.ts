import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateRemoteBranch, rebaseOntoBase } from "./rebase-onto-base";

function setupConflictingRepo(): {
  repoDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "rebase-onto-base-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  const decoPath = ".deco/blocks/shipping.json";

  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);

  mkdirSync(join(seed, ".deco/blocks"), { recursive: true });
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ threshold: 200 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);

  execSync(`git ${gitcfg} -C ${seed} checkout -b feat/shipping`, gitOpts);
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ threshold: 250 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${seed} commit -m "Update free shipping threshold to R$ 250"`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${seed} push -u origin feat/shipping`, gitOpts);

  // Diverge main so rebase always hits conflict resolution (modify/delete).
  execSync(`git ${gitcfg} -C ${seed} checkout main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} rm ${decoPath}`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${seed} commit -m "Remove shipping block from main"`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${seed} push origin main`, gitOpts);

  const repoDir = join(root, "workspace");
  execSync(
    `git ${gitcfg} clone --branch feat/shipping ${bare} ${repoDir}`,
    gitOpts,
  );
  execSync(
    `git ${gitcfg} -C ${repoDir} config user.email test@example.com`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${repoDir} config user.name test`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${repoDir} remote set-url origin ${bare}`,
    gitOpts,
  );

  return {
    repoDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * origin/feat/shipping gains a commit the workspace doesn't have (another
 * session published), while the workspace commits its own change — the exact
 * state that makes a blind `git push` fail as non-fast-forward.
 */
function setupDivergedSameBranchRepo(): {
  repoDir: string;
  bare: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "integrate-remote-branch-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  const decoPath = ".deco/blocks/shipping.json";

  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);

  mkdirSync(join(seed, ".deco/blocks"), { recursive: true });
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ threshold: 200 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M feat/shipping`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin feat/shipping`, gitOpts);

  const repoDir = join(root, "workspace");
  execSync(
    `git ${gitcfg} clone --branch feat/shipping ${bare} ${repoDir}`,
    gitOpts,
  );
  execSync(
    `git ${gitcfg} -C ${repoDir} config user.email test@example.com`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${repoDir} config user.name test`, gitOpts);

  // Another session pushes to the same branch behind the workspace's back.
  writeFileSync(join(seed, "other-session.txt"), "from another session\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m "other session"`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push origin feat/shipping`, gitOpts);

  // Workspace commits its own change, unaware of the remote commit.
  writeFileSync(
    join(repoDir, decoPath),
    JSON.stringify({ threshold: 300 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${repoDir} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${repoDir} commit -m "local save"`, gitOpts);

  return {
    repoDir,
    bare,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The real sandbox topology (setup/clone.ts, new-workspace path): shallow
 * single-branch clone of the default branch (`clone --depth 1`), workspace
 * branch forked locally with `checkout -B`, first save pushed with `-u`.
 * The clone's fetch refspec covers only `main`, so a plain
 * `fetch origin <branch>` never materializes refs/remotes/origin/<branch> —
 * the regression behind the "publish rejected as non-fast-forward" bug.
 */
function setupSandboxLikeDivergedRepo(): {
  repoDir: string;
  bare: string;
  seed: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "integrate-sandbox-like-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  const decoPath = ".deco/blocks/campaign-timer.json";

  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);
  mkdirSync(join(seed, ".deco/blocks"), { recursive: true });
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ copy: "deliver complete experiences" }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);

  // Sandbox clone: shallow + single-branch. file:// is required — plain local
  // paths ignore --depth and fall back to a full-refspec clone.
  const repoDir = join(root, "workspace");
  execSync(`git ${gitcfg} clone --depth 1 file://${bare} ${repoDir}`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${repoDir} config user.email test@example.com`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${repoDir} config user.name test`, gitOpts);
  // New workspace branch forked locally, first save published with -u.
  execSync(
    `git ${gitcfg} -C ${repoDir} checkout -B deco/new-workspace`,
    gitOpts,
  );
  writeFileSync(
    join(repoDir, decoPath),
    JSON.stringify({ copy: "first save from studio" }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${repoDir} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${repoDir} commit -m "first save"`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${repoDir} push -u origin deco/new-workspace`,
    gitOpts,
  );

  // Another environment commits to the same branch behind the sandbox's back.
  execSync(`git ${gitcfg} -C ${seed} fetch origin deco/new-workspace`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${seed} checkout -b deco/new-workspace origin/deco/new-workspace`,
    gitOpts,
  );
  writeFileSync(join(seed, "outside.txt"), "committed outside the studio\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m "outside change"`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push origin deco/new-workspace`, gitOpts);

  // Sandbox commits its next save, unaware of the outside commit.
  writeFileSync(
    join(repoDir, decoPath),
    JSON.stringify({ copy: "second save from studio" }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${repoDir} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${repoDir} commit -m "second save"`, gitOpts);

  return {
    repoDir,
    bare,
    seed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("integrateRemoteBranch", () => {
  it("integrates outside commits in a shallow single-branch sandbox clone", () => {
    const { repoDir, bare, cleanup } = setupSandboxLikeDivergedRepo();
    try {
      // Precondition of the regression: the clone's refspec only covers main,
      // so the workspace branch has no remote-tracking ref to compare against.
      const trackingRef = () => {
        try {
          return execSync(
            `git -C ${repoDir} rev-parse --verify refs/remotes/origin/deco/new-workspace`,
            { stdio: "pipe" },
          )
            .toString()
            .trim();
        } catch {
          return null;
        }
      };
      expect(trackingRef()).toBeNull();

      const { rebased } = integrateRemoteBranch(repoDir, "deco/new-workspace", {
        asUser: false,
      });
      expect(rebased).toBe(true);

      // Push must now fast-forward, with both saves and the outside commit.
      execSync(`git -C ${repoDir} push origin deco/new-workspace`, {
        stdio: "ignore",
      });
      const remoteHead = execSync(
        `git -C ${bare} rev-parse refs/heads/deco/new-workspace`,
      )
        .toString()
        .trim();
      const localHead = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      expect(remoteHead).toBe(localHead);
      const files = execSync(`git -C ${repoDir} ls-files`).toString();
      expect(files).toContain("outside.txt");
      const content = readFileSync(
        join(repoDir, ".deco/blocks/campaign-timer.json"),
        "utf-8",
      );
      expect(JSON.parse(content)).toEqual({ copy: "second save from studio" });
    } finally {
      cleanup();
    }
  });

  it("replays local commits on top of remote commits so push fast-forwards", () => {
    const { repoDir, bare, cleanup } = setupDivergedSameBranchRepo();
    try {
      const { rebased } = integrateRemoteBranch(repoDir, "feat/shipping", {
        asUser: false,
      });
      expect(rebased).toBe(true);

      // Remote branch is now an ancestor of HEAD → plain push succeeds.
      execSync(`git -C ${repoDir} push origin feat/shipping`, {
        stdio: "ignore",
      });

      // Both sides survived: the other session's file and the local save.
      const remoteHead = execSync(
        `git -C ${bare} rev-parse refs/heads/feat/shipping`,
      )
        .toString()
        .trim();
      const localHead = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      expect(remoteHead).toBe(localHead);
      const content = readFileSync(
        join(repoDir, ".deco/blocks/shipping.json"),
        "utf-8",
      );
      expect(JSON.parse(content)).toEqual({ threshold: 300 });
      const files = execSync(`git -C ${repoDir} ls-files`).toString();
      expect(files).toContain("other-session.txt");
    } finally {
      cleanup();
    }
  });

  it("prefers the local save when both sides edited the same file", () => {
    const { repoDir, bare, cleanup } = setupDivergedSameBranchRepo();
    try {
      // Make the remote's extra commit conflict with the local one.
      const seed = join(repoDir, "..", "seed");
      writeFileSync(
        join(seed, ".deco/blocks/shipping.json"),
        JSON.stringify({ threshold: 999 }, null, 2),
        "utf-8",
      );
      execSync(`git -C ${seed} add .`, { stdio: "ignore" });
      execSync(
        `git -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false -C ${seed} commit -m "conflicting remote edit"`,
        { stdio: "ignore" },
      );
      execSync(`git -C ${seed} push origin feat/shipping`, { stdio: "ignore" });

      const { rebased } = integrateRemoteBranch(repoDir, "feat/shipping", {
        asUser: false,
      });
      expect(rebased).toBe(true);

      const content = readFileSync(
        join(repoDir, ".deco/blocks/shipping.json"),
        "utf-8",
      );
      expect(JSON.parse(content)).toEqual({ threshold: 300 });

      execSync(`git -C ${repoDir} push origin feat/shipping`, {
        stdio: "ignore",
      });
      const remoteHead = execSync(
        `git -C ${bare} rev-parse refs/heads/feat/shipping`,
      )
        .toString()
        .trim();
      const localHead = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      expect(remoteHead).toBe(localHead);
    } finally {
      cleanup();
    }
  });

  it("is a no-op when the remote branch has nothing new", () => {
    const { repoDir, cleanup } = setupDivergedSameBranchRepo();
    try {
      execSync(`git -C ${repoDir} fetch origin feat/shipping`, {
        stdio: "ignore",
      });
      execSync(`git -C ${repoDir} rebase origin/feat/shipping`, {
        stdio: "ignore",
      });
      const before = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();

      const { rebased } = integrateRemoteBranch(repoDir, "feat/shipping", {
        asUser: false,
      });
      expect(rebased).toBe(false);
      const after = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("is a no-op when the branch does not exist on origin", () => {
    const { repoDir, cleanup } = setupDivergedSameBranchRepo();
    try {
      execSync(`git -C ${repoDir} checkout -b brand-new-branch`, {
        stdio: "ignore",
      });
      const { rebased } = integrateRemoteBranch(repoDir, "brand-new-branch", {
        asUser: false,
      });
      expect(rebased).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("rebaseOntoBase", () => {
  it("rebases with -X theirs and resolves conflicts from branch changes", () => {
    const { repoDir, cleanup } = setupConflictingRepo();
    try {
      rebaseOntoBase(repoDir, "main", { asUser: false });

      const content = readFileSync(
        join(repoDir, ".deco/blocks/shipping.json"),
        "utf-8",
      );
      expect(JSON.parse(content)).toEqual({ threshold: 250 });

      const head = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      const main = execSync(`git -C ${repoDir} rev-parse origin/main`)
        .toString()
        .trim();
      expect(head).not.toBe(main);
    } finally {
      cleanup();
    }
  });
});
