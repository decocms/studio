import { describe, expect, it } from "bun:test";
import { parseIssueKey, parseIssueKeys } from "./issue-key";

describe("parseIssueKey", () => {
  it("takes a key as typed, uppercased", () => {
    expect(parseIssueKey("ABC-123")).toBe("ABC-123");
    expect(parseIssueKey("  abc-123  ")).toBe("ABC-123");
    expect(parseIssueKey("A1_B-7")).toBe("A1_B-7");
  });

  it("takes the key out of a pasted link", () => {
    expect(parseIssueKey("https://x.atlassian.net/browse/ABC-123")).toBe(
      "ABC-123",
    );
    expect(
      parseIssueKey(
        "https://x.atlassian.net/browse/ABC-123?focusedCommentId=99",
      ),
    ).toBe("ABC-123");
    expect(
      parseIssueKey(
        "https://x.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-45",
      ),
    ).toBe("ABC-45");
  });

  /** Never hand Jira something that is not a key — the 404 it answers with
   *  reads like the integration is broken. */
  it("rejects anything that is not a key", () => {
    for (const bad of [
      "",
      "   ",
      "ABC",
      "123",
      "-123",
      "ABC-",
      "1ABC-2",
      "ABC 123",
      "ABC-12x",
      "https://x.atlassian.net/",
    ]) {
      expect(parseIssueKey(bad)).toBeNull();
    }
  });
});

describe("parseIssueKeys", () => {
  it("reads a pasted column of links and a typed list alike", () => {
    expect(
      parseIssueKeys("https://x.atlassian.net/browse/OS-1\nOS-2\n  OS-3  ")
        .keys,
    ).toEqual(["OS-1", "OS-2", "OS-3"]);
    expect(parseIssueKeys("OS-1, OS-2 ,OS-3").keys).toEqual([
      "OS-1",
      "OS-2",
      "OS-3",
    ]);
    // A real paste is both, plus blank lines.
    expect(parseIssueKeys("OS-1,OS-2\n\nOS-3;OS-4").keys).toEqual([
      "OS-1",
      "OS-2",
      "OS-3",
      "OS-4",
    ]);
  });

  // Silently starting nine runs and saying nothing about the tenth is the
  // failure this return shape exists to prevent.
  it("hands back what it could not read instead of dropping it", () => {
    const r = parseIssueKeys("OS-1\nnot a key\nOS-2\n???");
    expect(r.keys).toEqual(["OS-1", "OS-2"]);
    expect(r.invalid).toEqual(["not a key", "???"]);
  });

  it("collapses a repeat — firing twice would just supersede itself", () => {
    expect(parseIssueKeys("OS-1, os-1, OS-2").keys).toEqual(["OS-1", "OS-2"]);
  });

  it("is empty for an empty paste", () => {
    expect(parseIssueKeys("   \n\n ,, ")).toEqual({ keys: [], invalid: [] });
  });
});
