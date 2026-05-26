import { describe, expect, test } from "bun:test";
import {
  buildCommitContextSummary,
  fallbackCommitSuggestion,
} from "./suggest-commit-message";

describe("suggest-commit-message", () => {
  test("fallbackCommitSuggestion summarizes changed files", () => {
    const result = fallbackCommitSuggestion({
      modified: ["src/app.tsx"],
      created: [],
      deleted: [],
      not_added: [],
    });

    expect(result.title).toBe("Update src/app.tsx");
    expect(result.body).toContain("src/app.tsx");
    expect(result.message).toContain("update src/app.tsx");
  });

  test("buildCommitContextSummary includes diff snippets", () => {
    const summary = buildCommitContextSummary(
      {
        modified: ["README.md"],
        created: [],
        deleted: [],
        not_added: [],
      },
      {
        diffs: {
          "README.md": {
            from: "old line",
            to: "new line",
          },
        },
      },
    );

    expect(summary).toContain("Modified: README.md");
    expect(summary).toContain("README.md:");
    expect(summary).toContain("- old line");
    expect(summary).toContain("+ new line");
  });
});
