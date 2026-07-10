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
  it("installs an executable pre-push hook", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "protect-branch-"));
    try {
      installProtectedBranchHook(repoDir);
      const hookPath = join(repoDir, ".git", "hooks", "pre-push");
      expect(statSync(hookPath).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks pushes to main/master and allows other branches", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "protect-branch-"));
    try {
      installProtectedBranchHook(repoDir);
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
});
