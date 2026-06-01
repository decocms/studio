import { describe, expect, test } from "bun:test";
import type { BranchMeta } from "@decocms/sandbox/shared";
import {
  hasLocalWorkToPush,
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

  test("unknown SSE meta + git aheadOfBase → ready with commits vs base", () => {
    const merged = mergeBranchMetaWithGitStatus(
      { kind: "unknown" },
      {
        ...cleanStatus,
        aheadOfBase: 3,
        base: "main",
        headSha: "abc123",
      },
    );
    expect(merged.kind).toBe("ready");
    if (merged.kind === "ready") {
      expect(merged.aheadOfBase).toBe(3);
      expect(merged.base).toBe("main");
      expect(merged.headSha).toBe("abc123");
    }
  });

  test("unknown SSE + empty git status stays unknown", () => {
    const merged = mergeBranchMetaWithGitStatus(
      { kind: "unknown" },
      cleanStatus,
    );
    expect(merged.kind).toBe("unknown");
  });

  test("raises stale SSE aheadOfBase when git status reports more", () => {
    const merged = mergeBranchMetaWithGitStatus(
      { ...readyMeta, aheadOfBase: 0 },
      { ...cleanStatus, aheadOfBase: 2, base: "main" },
    );
    if (merged.kind === "ready") {
      expect(merged.aheadOfBase).toBe(2);
    }
  });
});

describe("hasLocalWorkToPush", () => {
  test("false when clean tree with only base diff context", () => {
    expect(hasLocalWorkToPush(cleanStatus)).toBe(false);
  });

  test("true when ahead of tracking", () => {
    expect(hasLocalWorkToPush({ ...cleanStatus, ahead: 1 })).toBe(true);
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

  test("false for empty diff", () => {
    expect(isDecoOnlyDiff({ diffs: {} })).toBe(false);
    expect(isDecoOnlyDiff(null)).toBe(false);
  });
});
