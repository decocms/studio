import { describe, expect, it } from "bun:test";
import { rebaseWorkspaceCwd } from "./rebase-workspace-cwd";

describe("rebaseWorkspaceCwd", () => {
  const appRoot = "/data/link/sandboxes/h1";

  it("passes null cwd through untouched", () => {
    expect(rebaseWorkspaceCwd(null, appRoot)).toBeNull();
  });

  it("rebases only /repo onto the sandbox root", () => {
    expect(rebaseWorkspaceCwd("/repo", appRoot)).toBe(
      "/data/link/sandboxes/h1/repo",
    );
  });
});
