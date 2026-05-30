import { describe, expect, it } from "bun:test";
import {
  countGitDiffFiles,
  decodeGithubFileContent,
} from "./github-pr-diff.ts";

describe("github-pr-diff", () => {
  it("countGitDiffFiles returns zero for empty diff", () => {
    expect(countGitDiffFiles(null)).toBe(0);
    expect(countGitDiffFiles({ diffs: {} })).toBe(0);
  });

  it("countGitDiffFiles counts diff entries", () => {
    expect(
      countGitDiffFiles({
        diffs: {
          "a.ts": { from: "a", to: "b" },
          "b.ts": { from: null, to: "new" },
        },
      }),
    ).toBe(2);
  });

  it("decodeGithubFileContent parses JSON string payloads", () => {
    const result = decodeGithubFileContent({
      content: [
        {
          type: "resource",
          resource: { text: JSON.stringify("hello") },
        },
      ],
    });
    expect(result).toBe("hello");
  });

  it("decodeGithubFileContent parses object content field", () => {
    const result = decodeGithubFileContent({
      content: [
        {
          type: "resource",
          resource: { text: JSON.stringify({ content: "file body" }) },
        },
      ],
    });
    expect(result).toBe("file body");
  });

  it("decodeGithubFileContent returns null for tool errors", () => {
    expect(decodeGithubFileContent({ isError: true })).toBeNull();
  });
});
