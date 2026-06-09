import { describe, expect, test } from "bun:test";
import {
  buildCommitContextSummary,
  fallbackCommitSuggestion,
  isGitStatusLike,
  parseCommitSuggestionJson,
} from "./suggest-commit-message";

describe("parseCommitSuggestionJson", () => {
  test("parses bare JSON", () => {
    const result = parseCommitSuggestionJson(
      '{"title":"Add feature","body":"Does the thing"}',
    );
    expect(result?.title).toBe("Add feature");
    expect(result?.body).toBe("Does the thing");
  });

  test("strips markdown fences", () => {
    const result = parseCommitSuggestionJson(
      '```json\n{"title":"Fix bug","body":""}\n```',
    );
    expect(result?.title).toBe("Fix bug");
  });

  test("falls back to first line as title", () => {
    const result = parseCommitSuggestionJson("Plain title\n\nMore detail");
    expect(result?.title).toBe("Plain title");
    expect(result?.body).toBe("More detail");
  });
});

describe("isGitStatusLike", () => {
  test("accepts valid status shape", () => {
    expect(
      isGitStatusLike({
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      }),
    ).toBe(true);
  });

  test("rejects non-objects and arrays", () => {
    expect(isGitStatusLike(null)).toBe(false);
    expect(isGitStatusLike("status")).toBe(false);
    expect(isGitStatusLike([])).toBe(false);
    expect(isGitStatusLike({ modified: [] })).toBe(false);
  });
});

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

  test("fallbackCommitSuggestion classifies diff-only add and delete", () => {
    const added = fallbackCommitSuggestion(
      {
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      },
      { diffs: { "routes/new.tsx": { from: null, to: "export {}" } } },
    );
    expect(added.message).toContain("add routes/new.tsx");

    const deleted = fallbackCommitSuggestion(
      {
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      },
      { diffs: { "routes/old.tsx": { from: "x", to: null } } },
    );
    expect(deleted.message).toContain("delete routes/old.tsx");
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
