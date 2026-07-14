import { describe, expect, it } from "bun:test";
import win32Path from "node:path/win32";
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

// `safePath` closes over the ambient `path` module (POSIX-flavored on this
// macOS/Linux CI runner), so we can't call `safePath` itself with
// win32-shaped inputs here. What broke on Windows CI was the *algorithm*: the
// old guard did `resolved.startsWith(workspaceRoot + "/")`, which can never
// match a win32 path (backslash-separated, drive-lettered — e.g.
// `D:\a\studio\studio\...`) regardless of the separator literal used. The fix
// replaced that with a `path.relative()`-based containment check (reject
// when the relative path is `..`, starts with `..<sep>`, or is itself
// absolute — the last case catching a different drive letter, where
// win32 `relative()` returns the absolute target unchanged).
//
// The block below exercises that exact algorithm through `node:path/win32`
// directly, with win32-shaped inputs, to confirm the containment logic holds
// under backslash separators and drive letters — i.e. that the new
// `safePath` body (which uses the same relative()-based shape against
// whichever `path` module is ambient) is platform-correct.
describe("safePath's relative()-based guard — win32 semantics (reasoned via node:path/win32)", () => {
  const guard = (
    root: string,
    base: string,
    userPath: string,
  ): string | null => {
    const resolved = win32Path.resolve(base, userPath);
    const rel = win32Path.relative(root, resolved);
    if (
      rel !== "" &&
      (rel === ".." ||
        rel.startsWith(`..${win32Path.sep}`) ||
        win32Path.isAbsolute(rel))
    ) {
      return null;
    }
    return resolved;
  };

  const root = "D:\\a\\studio\\studio\\.sandbox";
  const repo = "D:\\a\\studio\\studio\\.sandbox\\app";

  it("resolves relative paths against the repo", () => {
    expect(guard(root, repo, "src\\index.ts")).toBe(
      "D:\\a\\studio\\studio\\.sandbox\\app\\src\\index.ts",
    );
  });

  it("returns the repo for empty / dot paths", () => {
    expect(guard(root, repo, "")).toBe(repo);
    expect(guard(root, repo, ".")).toBe(repo);
  });

  it("rejects paths that escape the workspace", () => {
    expect(guard(root, repo, "..\\..\\etc\\passwd")).toBeNull();
  });

  it("rejects a different drive letter even if the path string looks unrelated", () => {
    expect(guard(root, repo, "C:\\Windows\\System32")).toBeNull();
  });

  it("allows absolute win32 paths inside the workspace", () => {
    expect(
      guard(root, repo, "D:\\a\\studio\\studio\\.sandbox\\app\\src\\x.ts"),
    ).toBe("D:\\a\\studio\\studio\\.sandbox\\app\\src\\x.ts");
  });
});
