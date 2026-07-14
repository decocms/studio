import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProtectedBranchHook } from "./protect-branch";

function runHook(
  hookPath: string,
  remoteRef: string,
): { status: number; stderr: string } {
  try {
    execFileSync(hookPath, {
      input: `refs/heads/x local-sha ${remoteRef} remote-sha\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stderr: Buffer };
    return { status: e.status, stderr: e.stderr.toString() };
  }
}

describe("installProtectedBranchHook", () => {
  it("installs an executable pre-push hook", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "protect-branch-"));
    try {
      await installProtectedBranchHook(repoDir);
      const hookPath = join(repoDir, ".git", "hooks", "pre-push");
      expect(statSync(hookPath).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks pushes to main/master and allows other branches", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "protect-branch-"));
    try {
      await installProtectedBranchHook(repoDir);
      const hookPath = join(repoDir, ".git", "hooks", "pre-push");

      const main = runHook(hookPath, "refs/heads/main");
      expect(main.status).not.toBe(0);
      expect(main.stderr).toContain("not allowed from a sandbox");

      const master = runHook(hookPath, "refs/heads/master");
      expect(master.status).not.toBe(0);

      const feature = runHook(hookPath, "refs/heads/feature/x");
      expect(feature.status).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("also blocks pushes to the repo's actual default branch when it isn't main/master", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "protect-branch-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync(
        "git",
        [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/release",
        ],
        { cwd: repoDir },
      );

      await installProtectedBranchHook(repoDir);
      const hookPath = join(repoDir, ".git", "hooks", "pre-push");

      const release = runHook(hookPath, "refs/heads/release");
      expect(release.status).not.toBe(0);
      expect(release.stderr).toContain("not allowed from a sandbox");

      const feature = runHook(hookPath, "refs/heads/feature/x");
      expect(feature.status).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
