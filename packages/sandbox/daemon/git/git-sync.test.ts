import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSync } from "./git-sync";

describe("gitSync", () => {
  it("runs a successful git command and returns stdout", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "git-sync-"));
    try {
      gitSync(["init"], { cwd: repoDir, asUser: false });
      const out = gitSync(["rev-parse", "--is-inside-work-tree"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(out).toBe("true");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("throws with stderr attached on non-zero exit", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "git-sync-"));
    try {
      try {
        gitSync(["rev-parse", "--verify", "does/not/exist"], {
          cwd: repoDir,
          asUser: false,
        });
        throw new Error("should have thrown");
      } catch (err) {
        const e = err as Error & { stderr?: string; status?: number };
        expect(e.message).toContain("git rev-parse");
        expect(e.status).toBeGreaterThan(0);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
