import { describe, expect, test } from "bun:test";
import {
  canPublishDirectly,
  hasGitLocalWork,
  hasLocalWorkToPush,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  PUBLISH_MIXED_WORK_TOOLTIP,
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

  test("allows a deco-only working-tree diff with no commits ahead", () => {
    const gate = canPublishDirectly(
      { ...cleanStatus, modified: [".deco/blocks/home.json"] },
      decoDiff,
    );
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  test("allows deco-only committed work on a clean tree", () => {
    const gate = canPublishDirectly(
      { ...cleanStatus, aheadOfBase: 1 },
      decoDiff,
    );
    expect(gate.allowed).toBe(true);
  });

  test("blocks code changes with the submit-for-review reason", () => {
    const gate = canPublishDirectly(
      { ...cleanStatus, modified: ["routes/index.tsx"] },
      codeDiff,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(PUBLISH_REQUIRES_SUBMIT_TOOLTIP);
  });

  // The safety regression this guards: a deco-only working-tree diff on top of
  // an unreviewed code commit ahead of base must NOT publish directly — the
  // gate can't see the committed code, so it must refuse the mixed payload.
  test("blocks a deco working-tree edit sitting on a commit ahead of base", () => {
    const gate = canPublishDirectly(
      { ...cleanStatus, modified: [".deco/blocks/home.json"], aheadOfBase: 1 },
      decoDiff,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(PUBLISH_MIXED_WORK_TOOLTIP);
  });

  test("blocks an empty diff", () => {
    expect(canPublishDirectly(cleanStatus, { diffs: {} }).allowed).toBe(false);
  });
});
