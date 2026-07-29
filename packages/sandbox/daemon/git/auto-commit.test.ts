import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { retry } from "@decocms/shared/std";
import { AutoCommitter, shouldAutoCommit } from "./auto-commit";
import type { BranchMeta } from "../events/types";
import { gitSync } from "./git-sync";

const PROTECTED = new Set(["main", "master"]);

function ready(over: Partial<Extract<BranchMeta, { kind: "ready" }>>) {
  return {
    kind: "ready",
    branch: "sandbox-work",
    base: "main",
    workingTreeDirty: false,
    unpushed: 0,
    aheadOfBase: 0,
    behindBase: 0,
    headSha: "abc",
    ...over,
  } satisfies BranchMeta;
}

describe("shouldAutoCommit", () => {
  it("commits a dirty working tree", () => {
    expect(shouldAutoCommit(ready({ workingTreeDirty: true }), PROTECTED)).toBe(
      true,
    );
  });

  // Commits the agent made itself via bash are just as lost as uncommitted
  // work if the remote never sees them.
  it("pushes a clean tree that still has unpushed commits", () => {
    expect(shouldAutoCommit(ready({ unpushed: 2 }), PROTECTED)).toBe(true);
  });

  it("does nothing when the tree is clean and fully pushed", () => {
    expect(shouldAutoCommit(ready({}), PROTECTED)).toBe(false);
  });

  // stageAndCommit() refuses these anyway — bailing here keeps a sandbox
  // sitting on main from logging a warning on every tick.
  it("skips protected branches", () => {
    expect(
      shouldAutoCommit(
        ready({ branch: "main", workingTreeDirty: true }),
        PROTECTED,
      ),
    ).toBe(false);
  });

  it("skips until the repo is ready (cloning, detached HEAD, unknown)", () => {
    expect(shouldAutoCommit({ kind: "unknown" }, PROTECTED)).toBe(false);
  });
});

// A feature-branch working repo wired to a real bare `origin`, so tick()'s
// commit AND push both actually run against git.
function initRepoWithRemote(): { repoDir: string; bare: string } {
  const appRoot = mkdtempSync(join(tmpdir(), "auto-commit-"));
  const bare = join(appRoot, "origin.git");
  const repoDir = join(appRoot, "app");
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
  g(["checkout", "-b", "sandbox-work"], repoDir);
  return { repoDir, bare };
}

function remoteFileList(bare: string, branch: string): string {
  return gitSync(["ls-tree", "-r", "--name-only", branch], {
    cwd: bare,
    asUser: false,
  });
}

describe("AutoCommitter.tick", () => {
  function makeCommitter(
    repoDir: string,
    over: { enabled?: boolean; dirty?: boolean; debounceMs?: number } = {},
  ) {
    return new AutoCommitter({
      gitDeps: { appRoot: join(repoDir, ".."), repoDir },
      getBranchMeta: () =>
        ready({ branch: "sandbox-work", workingTreeDirty: over.dirty ?? true }),
      isEnabled: () => over.enabled ?? true,
      debounceMs: over.debounceMs,
    });
  }

  it("commits and pushes work in progress to origin", async () => {
    const { repoDir, bare } = initRepoWithRemote();
    writeFileSync(join(repoDir, "agent-work.ts"), "export const x = 1;\n");

    await makeCommitter(repoDir).tick();

    expect(remoteFileList(bare, "sandbox-work")).toContain("agent-work.ts");
  });

  // The primary trigger: a file write nudges, and the save lands once the
  // writes settle — not on the 30 s interval.
  it("saves after a nudge's debounce elapses, coalescing a burst", async () => {
    const { repoDir, bare } = initRepoWithRemote();
    const committer = makeCommitter(repoDir, { debounceMs: 20 });

    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(join(repoDir, name), "export const x = 1;\n");
      committer.nudge();
    }
    // The debounced tick pushes on its own schedule — poll for the result
    // rather than guessing how long a local git push takes.
    const remote = await retry(() => remoteFileList(bare, "sandbox-work"), {
      minTimeout: 20,
      maxTimeout: 100,
      maxAttempts: 20,
    });
    expect(remote).toContain("a.ts");
    expect(remote).toContain("c.ts");
    // One commit for the whole burst, not one per write.
    expect(
      gitSync(["rev-list", "--count", "main..sandbox-work"], {
        cwd: bare,
        asUser: false,
      }),
    ).toBe("1");
  });

  it("does nothing when disabled by config", async () => {
    const { repoDir, bare } = initRepoWithRemote();
    writeFileSync(join(repoDir, "agent-work.ts"), "export const x = 1;\n");

    await makeCommitter(repoDir, { enabled: false }).tick();

    expect(() => remoteFileList(bare, "sandbox-work")).toThrow();
  });
});
