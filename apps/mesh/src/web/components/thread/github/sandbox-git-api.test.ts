import { describe, expect, test } from "bun:test";
import type { BranchMeta } from "@decocms/sandbox/shared";
import {
  hasUnpublishedWork,
  isDecoOnlyDiff,
  mergeBranchMetaWithGitStatus,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

const readyMeta: BranchMeta = {
  kind: "ready",
  branch: "feat/foo",
  base: "main",
  workingTreeDirty: true,
  unpushed: 0,
  aheadOfBase: 0,
  behindBase: 0,
  headSha: "abc",
};

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

describe("mergeBranchMetaWithGitStatus", () => {
  test("clears stale SSE dirty flag when git status is clean", () => {
    const merged = mergeBranchMetaWithGitStatus(readyMeta, cleanStatus);
    expect(merged.kind).toBe("ready");
    if (merged.kind === "ready") {
      expect(merged.workingTreeDirty).toBe(false);
    }
  });

  test("preserves unpushed count from git ahead", () => {
    const merged = mergeBranchMetaWithGitStatus(readyMeta, {
      ...cleanStatus,
      ahead: 2,
    });
    if (merged.kind === "ready") {
      expect(merged.unpushed).toBe(2);
    }
  });
});

describe("hasUnpublishedWork", () => {
  test("true when only unpushed commits exist", () => {
    expect(hasUnpublishedWork({ ...cleanStatus, ahead: 1 }, null)).toBe(true);
  });

  test("true when diff has entries", () => {
    const diff: GitDiffResult = {
      diffs: { "a.ts": { from: "a", to: "b" } },
    };
    expect(hasUnpublishedWork(cleanStatus, diff)).toBe(true);
  });

  test("false when clean with no unpushed commits", () => {
    expect(hasUnpublishedWork(cleanStatus, { diffs: {} })).toBe(false);
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

  test("false for empty diff", () => {
    expect(isDecoOnlyDiff({ diffs: {} })).toBe(false);
    expect(isDecoOnlyDiff(null)).toBe(false);
  });
});
