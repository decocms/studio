import { describe, expect, test } from "bun:test";
import { resolveShell } from "./resolve-shell";
import { ShellNotFoundError } from "./pty-spawn";

describe("resolveShell", () => {
  test("posix returns the requested shell verbatim", () => {
    expect(resolveShell("sh", { platform: "linux" })).toBe("sh");
    expect(resolveShell("bash", { platform: "darwin" })).toBe("bash");
  });

  test("win32 prefers DECO_SHELL when it exists", () => {
    expect(
      resolveShell("bash", {
        platform: "win32",
        env: { DECO_SHELL: "C:\\tools\\bash.exe" },
        exists: (p) => p === "C:\\tools\\bash.exe",
        whichGit: () => null,
      }),
    ).toBe("C:\\tools\\bash.exe");
  });

  test("win32 resolves Git Bash from the git install root", () => {
    expect(
      resolveShell("sh", {
        platform: "win32",
        env: {},
        exists: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
        whichGit: () => "C:\\Program Files\\Git\\cmd\\git.exe",
      }),
    ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  test("win32 with no git and no DECO_SHELL throws the legible error", () => {
    expect(() =>
      resolveShell("sh", {
        platform: "win32",
        env: {},
        exists: () => false,
        whichGit: () => null,
      }),
    ).toThrow(ShellNotFoundError);
  });

  test("win32 resolves Git Bash from a mingw64-shaped git install (3 ancestor levels)", () => {
    expect(
      resolveShell("bash", {
        platform: "win32",
        env: {},
        exists: (p) => p === "C:\\Git\\bin\\bash.exe",
        whichGit: () => "C:\\Git\\mingw64\\bin\\git.exe",
      }),
    ).toBe("C:\\Git\\bin\\bash.exe");
  });

  test("win32 tries every line of a multi-match `where git` output", () => {
    expect(
      resolveShell("bash", {
        platform: "win32",
        env: {},
        exists: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
        whichGit: () =>
          "C:\\Users\\runner\\scoop\\shims\\git.exe\r\nC:\\Program Files\\Git\\cmd\\git.exe\r\n",
      }),
    ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  test("win32 falls back to the well-known default install path as a last resort", () => {
    expect(
      resolveShell("bash", {
        platform: "win32",
        env: {},
        exists: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
        whichGit: () => null,
      }),
    ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });
});
