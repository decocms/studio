import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkspaceIsDecoSite } from "./coding-workspace-deco";

describe("localWorkspaceIsDecoSite", () => {
  test("returns false when there is no checkout (cwd: null)", () => {
    expect(localWorkspaceIsDecoSite(null)).toBe(false);
  });

  test("detects a `.deco/` directory in process.cwd() for the /repo checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "deco-site-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".deco"));
      process.chdir(dir);
      expect(localWorkspaceIsDecoSite("/repo")).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns false for a /repo checkout without a `.deco/` directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-repo-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      expect(localWorkspaceIsDecoSite("/repo")).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
