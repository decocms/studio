import { describe, expect, it } from "bun:test";
import { parseIssueKey } from "./issue-key";

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
