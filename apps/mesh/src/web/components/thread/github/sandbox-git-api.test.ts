import { describe, expect, test } from "bun:test";
import {
  canPublishDirectly,
  combinePublishDiffs,
  hasGitLocalWork,
  hasLocalWorkToPush,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  PUBLISH_REQUIRES_SUBMIT_TOOLTIP,
  shouldUseBaseDiff,
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

  test("true for a subdir package path (`<pkg>/.deco/...` + generated assets)", () => {
    const diff: GitDiffResult = {
      diffs: {
        "eitri-shopping-monte-carlo-shared/.deco/blocks/foo.json": {
          from: "{}",
          to: "{}",
        },
        "eitri-shopping-monte-carlo-shared/.deco/blocks.gen.json": {
          from: "{}",
          to: '{"foo":{}}',
        },
        "eitri-shopping-monte-carlo-shared/static/tailwind.css": {
          from: "a",
          to: "b",
        },
      },
    };
    expect(isDecoOnlyDiff(diff)).toBe(true);
  });

  test("false when subdir code changes alongside `<pkg>/.deco`", () => {
    const diff: GitDiffResult = {
      diffs: {
        "pkg/.deco/blocks/foo.json": { from: "{}", to: "{}" },
        "pkg/routes/index.tsx": { from: "a", to: "b" },
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

describe("hasGitLocalWork", () => {
  test("false for null and a clean tree", () => {
    expect(hasGitLocalWork(null)).toBe(false);
    expect(hasGitLocalWork(cleanStatus)).toBe(false);
  });

  test("true for modified working-tree files", () => {
    expect(hasGitLocalWork({ ...cleanStatus, modified: ["a.ts"] })).toBe(true);
  });

  test("true for staged files", () => {
    expect(hasGitLocalWork({ ...cleanStatus, staged: ["a.ts"] })).toBe(true);
  });

  test("true for conflicted files", () => {
    expect(hasGitLocalWork({ ...cleanStatus, conflicted: ["a.ts"] })).toBe(
      true,
    );
  });

  test("false when only ahead/unpushed (committed, clean tree)", () => {
    expect(hasGitLocalWork({ ...cleanStatus, ahead: 2, unpushed: 2 })).toBe(
      false,
    );
  });
});

describe("shouldUseBaseDiff", () => {
  const opts = { openPrFromCommits: false, commitToOpenPr: false };

  test("false when the working tree is dirty (show working-tree diff)", () => {
    expect(
      shouldUseBaseDiff(
        { ...cleanStatus, modified: ["a.ts"], aheadOfBase: 3 },
        opts,
      ),
    ).toBe(false);
  });

  test("true for a clean tree with commits ahead of base", () => {
    expect(shouldUseBaseDiff({ ...cleanStatus, aheadOfBase: 2 }, opts)).toBe(
      true,
    );
  });

  test("true when opening a PR from existing commits", () => {
    expect(
      shouldUseBaseDiff(cleanStatus, {
        openPrFromCommits: true,
        commitToOpenPr: false,
      }),
    ).toBe(true);
  });

  test("false when committing to an already-open PR", () => {
    expect(
      shouldUseBaseDiff(
        { ...cleanStatus, aheadOfBase: 2 },
        { openPrFromCommits: false, commitToOpenPr: true },
      ),
    ).toBe(false);
  });

  test("false for a clean tree with nothing ahead of base", () => {
    expect(shouldUseBaseDiff(cleanStatus, opts)).toBe(false);
  });
});

describe("canPublishDirectly", () => {
  const decoDiff: GitDiffResult = {
    diffs: { ".deco/blocks/home.json": { from: "{}", to: "{}" } },
  };
  const codeDiff: GitDiffResult = {
    diffs: { "routes/index.tsx": { from: "a", to: "b" } },
  };

  test("allows a deco-only payload", () => {
    const gate = canPublishDirectly(decoDiff);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  test("blocks a payload containing code", () => {
    const gate = canPublishDirectly(codeDiff);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(PUBLISH_REQUIRES_SUBMIT_TOOLTIP);
  });

  test("blocks an empty diff", () => {
    expect(canPublishDirectly({ diffs: {} }).allowed).toBe(false);
  });
});

describe("combinePublishDiffs (full publish payload = committed ∪ working)", () => {
  const committedDeco: GitDiffResult = {
    mergeBaseSha: "abc",
    diffs: { ".deco/a.json": { from: "{}", to: "{}" } },
  };
  const workingDeco: GitDiffResult = {
    diffs: { ".deco/b.json": { from: null, to: "{}" } },
  };

  test("unions committed and working-tree paths, keeps mergeBaseSha", () => {
    const combined = combinePublishDiffs(committedDeco, workingDeco);
    expect(Object.keys(combined.diffs).sort()).toEqual([
      ".deco/a.json",
      ".deco/b.json",
    ]);
    expect(combined.mergeBaseSha).toBe("abc");
  });

  test("handles null inputs", () => {
    expect(combinePublishDiffs(null, null).diffs).toEqual({});
  });

  // The case users hit: an uncommitted deco edit on top of a committed deco
  // change publishes directly, because the whole payload is deco-only.
  test("allows deco committed + deco uncommitted", () => {
    const gate = canPublishDirectly(
      combinePublishDiffs(committedDeco, workingDeco),
    );
    expect(gate.allowed).toBe(true);
  });

  // The safety case: an uncommitted deco edit on top of a committed CODE change
  // must still be blocked — the combined payload exposes the committed code.
  test("blocks deco uncommitted sitting on committed code", () => {
    const committedCode: GitDiffResult = {
      diffs: { "routes/x.tsx": { from: "a", to: "b" } },
    };
    const gate = canPublishDirectly(
      combinePublishDiffs(committedCode, workingDeco),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(PUBLISH_REQUIRES_SUBMIT_TOOLTIP);
  });
});
