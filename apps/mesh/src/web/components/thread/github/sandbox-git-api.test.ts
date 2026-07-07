import { describe, expect, test } from "bun:test";
import {
  hasLocalWorkToPush,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  stripGeneratedFilesFromDiff,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

const cleanStatus: GitStatus = {
  not_added: [],
  conflicted: [],
  created: [],
  deleted: [],
  modified: [],
  renamed: [],
  files: [],
  staged: [],
  ahead: 0,
  behind: 0,
  current: "feat/foo",
  tracking: "origin/feat/foo",
  detached: false,
};

describe("hasLocalWorkToPush", () => {
  test("false when clean tree with only base diff context", () => {
    expect(hasLocalWorkToPush(cleanStatus)).toBe(false);
  });

  test("true when ahead of tracking", () => {
    expect(hasLocalWorkToPush({ ...cleanStatus, ahead: 1 })).toBe(true);
  });

  test("true when unpushed is set without upstream tracking", () => {
    expect(
      hasLocalWorkToPush({
        ...cleanStatus,
        tracking: null,
        ahead: 0,
        unpushed: 1,
        aheadOfBase: 1,
      }),
    ).toBe(true);
  });

  test("true when ahead of base on a branch with no upstream (legacy daemon)", () => {
    expect(
      hasLocalWorkToPush({
        ...cleanStatus,
        tracking: null,
        ahead: 0,
        aheadOfBase: 1,
      }),
    ).toBe(true);
  });

  test("false when daemon reports unpushed 0 with no upstream", () => {
    expect(
      hasLocalWorkToPush({
        ...cleanStatus,
        tracking: null,
        ahead: 0,
        unpushed: 0,
        aheadOfBase: 1,
      }),
    ).toBe(false);
  });
});

describe("hasUnpublishedWork", () => {
  test("true when only unpushed commits exist", () => {
    expect(hasUnpublishedWork({ ...cleanStatus, ahead: 1 }, null)).toBe(true);
  });

  test("true when working-tree diff has entries", () => {
    const diff: GitDiffResult = {
      diffs: { "a.ts": { from: "a", to: "b" } },
    };
    expect(hasUnpublishedWork(cleanStatus, diff)).toBe(true);
  });

  test("false when clean with no unpushed commits and empty diff", () => {
    expect(hasUnpublishedWork(cleanStatus, { diffs: {} })).toBe(false);
  });
});

describe("open-pr push gating", () => {
  test("base diff alone must not imply unpublished work to push", () => {
    const baseDiff: GitDiffResult = {
      diffs: { ".deco/blocks/home.json": { from: "{}", to: "{}" } },
    };
    expect(hasLocalWorkToPush(cleanStatus)).toBe(false);
    expect(hasUnpublishedWork(cleanStatus, baseDiff)).toBe(true);
  });
});

describe("isDecoOnlyDiff", () => {
  test("true when all paths are under .deco", () => {
    const diff: GitDiffResult = {
      diffs: {
        ".deco/blocks/foo.json": { from: "{}", to: "{}" },
        ".deco/meta.json": { from: null, to: "{}" },
      },
    };
    expect(isDecoOnlyDiff(diff)).toBe(true);
  });

  test("false when any path is outside .deco", () => {
    const diff: GitDiffResult = {
      diffs: {
        ".deco/blocks/foo.json": { from: "{}", to: "{}" },
        "routes/index.tsx": { from: "a", to: "b" },
      },
    };
    expect(isDecoOnlyDiff(diff)).toBe(false);
  });

  test("true when diff includes auto-generated blocks.gen.json", () => {
    const diff: GitDiffResult = {
      diffs: {
        ".deco/blocks/foo.json": { from: "{}", to: "{}" },
        "src/server/cms/blocks.gen.json": { from: "{}", to: '{"foo":{}}' },
      },
    };
    expect(isDecoOnlyDiff(diff)).toBe(true);
  });

  test("false when blocks.gen.json changes alongside code", () => {
    const diff: GitDiffResult = {
      diffs: {
        "src/server/cms/blocks.gen.json": { from: "{}", to: '{"foo":{}}' },
        "routes/index.tsx": { from: "a", to: "b" },
      },
    };
    expect(isDecoOnlyDiff(diff)).toBe(false);
  });

  test("false for empty diff", () => {
    expect(isDecoOnlyDiff({ diffs: {} })).toBe(false);
    expect(isDecoOnlyDiff(null)).toBe(false);
  });
});

describe("stripGeneratedFilesFromDiff", () => {
  test("drops blocks.gen.json and tailwind css, keeps source", () => {
    const diff: GitDiffResult = {
      mergeBaseSha: "abc",
      diffs: {
        "routes/index.tsx": { from: "a", to: "b" },
        "src/server/cms/blocks.gen.json": { from: "{}", to: '{"foo":{}}' },
        "static/tailwind.css": { from: ".a{}", to: ".a{}.b{}" },
        "src/static/tailwind.css": { from: "x", to: "y" },
        ".deco/blocks/home.json": { from: "{}", to: "{}" },
      },
    };
    const stripped = stripGeneratedFilesFromDiff(diff);
    expect(Object.keys(stripped.diffs).sort()).toEqual([
      ".deco/blocks/home.json",
      "routes/index.tsx",
    ]);
    expect(stripped.mergeBaseSha).toBe("abc");
  });

  test("does not mutate the input diff", () => {
    const diff: GitDiffResult = {
      diffs: { "blocks.gen.json": { from: "{}", to: '{"a":{}}' } },
    };
    stripGeneratedFilesFromDiff(diff);
    expect(Object.keys(diff.diffs)).toEqual(["blocks.gen.json"]);
  });
});
