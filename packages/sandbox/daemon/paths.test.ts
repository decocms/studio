import { describe, expect, it } from "bun:test";
import { safePath } from "./paths";

describe("safePath", () => {
  const workspace = "/workspace";
  const repo = "/workspace/app";

  it("resolves relative paths against the repo (matching bash cwd)", () => {
    expect(safePath(workspace, repo, "src/index.ts")).toBe(
      "/workspace/app/src/index.ts",
    );
  });

  it("returns the repo for empty / dot paths", () => {
    expect(safePath(workspace, repo, "")).toBe("/workspace/app");
    expect(safePath(workspace, repo, ".")).toBe("/workspace/app");
  });

  it("allows escaping the repo into workspace siblings (logs)", () => {
    expect(safePath(workspace, repo, "../tmp/app/dev")).toBe(
      "/workspace/tmp/app/dev",
    );
  });

  it("rejects paths that escape the workspace", () => {
    expect(safePath(workspace, repo, "../../etc/passwd")).toBeNull();
    expect(safePath(workspace, repo, "a/../../../etc")).toBeNull();
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(safePath(workspace, repo, "/etc/passwd")).toBeNull();
  });

  it("allows absolute paths inside the workspace", () => {
    expect(safePath(workspace, repo, "/workspace/app/src/x.ts")).toBe(
      "/workspace/app/src/x.ts",
    );
    expect(safePath(workspace, repo, "/workspace/tmp/app/dev")).toBe(
      "/workspace/tmp/app/dev",
    );
  });
});
