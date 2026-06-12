import { describe, expect, it } from "bun:test";
import { rebaseWorkspaceCwd } from "./rebase-workspace-cwd";

describe("rebaseWorkspaceCwd", () => {
  const appRoot = "/data/link/sandboxes/h1";

  it("passes the default sentinel through untouched", () => {
    expect(rebaseWorkspaceCwd("default", appRoot)).toBe("default");
  });

  it("rebases /repo onto the sandbox root", () => {
    expect(rebaseWorkspaceCwd("/repo", appRoot)).toBe(
      "/data/link/sandboxes/h1/repo",
    );
  });

  it("contains escape attempts — falls back to default, never fails", () => {
    expect(rebaseWorkspaceCwd("/../../etc", appRoot)).toBe("default");
    expect(rebaseWorkspaceCwd("/repo/../../..", appRoot)).toBe("default");
  });
});
