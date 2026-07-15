import { describe, expect, it } from "bun:test";
import { localFileManagerName } from "./open-local-folder";

describe("localFileManagerName", () => {
  it("uses Finder for a macOS path", () => {
    expect(localFileManagerName("/Users/me/project")).toBe("Finder");
  });

  it("uses File Explorer for a Windows drive path", () => {
    expect(localFileManagerName("C:\\Users\\me\\project")).toBe(
      "File Explorer",
    );
  });

  it("uses File Explorer for a Windows UNC path", () => {
    expect(localFileManagerName("\\\\server\\share\\project")).toBe(
      "File Explorer",
    );
  });
});
