import { describe, expect, test } from "bun:test";
import {
  buildChangeContextSummary,
  isGitStatusLike,
} from "./git-change-context";

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

describe("buildChangeContextSummary", () => {
  test("includes diff-only paths vs base", () => {
    const summary = buildChangeContextSummary(
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

  test("classifies diff-only add and delete", () => {
    const summary = buildChangeContextSummary(
      {
        modified: [],
        created: [],
        deleted: [],
        not_added: [],
      },
      {
        diffs: {
          "routes/new.tsx": { from: null, to: "export {}" },
          "routes/old.tsx": { from: "x", to: null },
        },
      },
    );

    expect(summary).toContain("Added: routes/new.tsx");
    expect(summary).toContain("Deleted: routes/old.tsx");
  });

  test("includes diff snippets", () => {
    const summary = buildChangeContextSummary(
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
