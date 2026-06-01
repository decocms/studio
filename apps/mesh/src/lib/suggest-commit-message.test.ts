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

  test("fallbackCommitSuggestion uses diff paths when working tree is clean", () => {
    const result = fallbackCommitSuggestion(
      {
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      },
      {
        diffs: {
          ".deco/blocks/pages-home.json": { from: "{}", to: "{}" },
        },
      },
    );

    expect(result.title).toBe("Update .deco/blocks/pages-home.json");
    expect(result.body).toContain(".deco/blocks/pages-home.json");
  });

  test("buildCommitContextSummary includes diff-only paths vs base", () => {
    const summary = buildCommitContextSummary(
      {
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      },
      {
        diffs: {
          ".deco/blocks/pages-home.json": {
            from: "old",
            to: "new",
          },
        },
      },
    );

    expect(summary).toContain("Changed: .deco/blocks/pages-home.json");
    expect(summary).toContain("+ new");
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
