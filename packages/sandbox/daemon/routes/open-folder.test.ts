import { describe, expect, it } from "bun:test";
import { resolveFolderOpenCommand } from "./open-folder";

describe("resolveFolderOpenCommand", () => {
  it("opens the repo itself in macOS Finder", () => {
    expect(resolveFolderOpenCommand("darwin", "/Users/me/project")).toEqual({
      executable: "/usr/bin/open",
      args: ["/Users/me/project"],
    });
  });

  it("opens the repo itself in Windows File Explorer", () => {
    expect(resolveFolderOpenCommand("win32", "C:\\Users\\me\\project")).toEqual(
      {
        executable: "explorer.exe",
        args: ["C:\\Users\\me\\project"],
      },
    );
  });

  it("does not launch a file manager on unsupported platforms", () => {
    expect(resolveFolderOpenCommand("linux", "/home/me/project")).toBeNull();
  });
});
