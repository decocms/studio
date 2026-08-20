import { afterEach, describe, expect, test } from "bun:test";
import {
  canPublishDirectly,
  combinePublishDiffs,
  DEFAULT_PUBLISH_POLICY,
  fetchGitStatus,
  hasGitLocalWork,
  hasLocalWorkToPush,
  hasNothingToReview,
  hasPublishableLocalWork,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  isDecoOnlyPaths,
  isSandboxUnreachable,
  needsSmartReviewJudgment,
  normalizePublishPolicy,
  resolvePathGate,
  reviewDiffSignature,
  sandboxGitStatusQueryKey,
  sandboxGitStatusQueryOptions,
  shouldUseBaseDiff,
  smartReviewGate,
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

describe("hasPublishableLocalWork", () => {
  const GENERATED = [
    ".deco/generate.digests.json",
    ".deco/meta.gen.json",
    "blocks.gen.json",
    "static/tailwind.css",
  ];

  test("false for null and a clean tree", () => {
    expect(hasPublishableLocalWork(null)).toBe(false);
    expect(hasPublishableLocalWork(cleanStatus)).toBe(false);
  });

  test("false when only generated artifacts changed", () => {
    expect(
      hasPublishableLocalWork({
        ...cleanStatus,
        modified: GENERATED,
        staged: [".deco/generate.digests.json"],
      }),
    ).toBe(false);
  });

  test("true when a block changed alongside generated artifacts", () => {
    expect(
      hasPublishableLocalWork({
        ...cleanStatus,
        modified: [...GENERATED, ".deco/blocks/hero.json"],
      }),
    ).toBe(true);
  });

  test("true for conflicts even with no listed paths", () => {
    expect(
      hasPublishableLocalWork({ ...cleanStatus, conflicted: ["a.ts"] }),
    ).toBe(true);
  });

  test("counts created, deleted and untracked content", () => {
    expect(
      hasPublishableLocalWork({
        ...cleanStatus,
        created: [".deco/blocks/a.json"],
      }),
    ).toBe(true);
    expect(
      hasPublishableLocalWork({
        ...cleanStatus,
        deleted: [".deco/blocks/a.json"],
      }),
    ).toBe(true);
    expect(
      hasPublishableLocalWork({
        ...cleanStatus,
        not_added: [".deco/blocks/a.json"],
      }),
    ).toBe(true);
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

  test("blocks a payload containing code (reason localized in UI)", () => {
    const gate = canPublishDirectly(codeDiff);
    expect(gate.allowed).toBe(false);
    // No inline reason: the deterministic code-review block is rendered as a
    // localized generic tooltip at the component level.
    expect(gate.reason).toBeNull();
  });

  test("blocks an empty diff", () => {
    expect(canPublishDirectly({ diffs: {} }).allowed).toBe(false);
  });

  test("defaults to code-review behavior (deco allowed, code blocked)", () => {
    expect(canPublishDirectly(decoDiff, "code-review").allowed).toBe(true);
    expect(canPublishDirectly(codeDiff, "code-review").allowed).toBe(false);
  });

  test("open policy allows code directly", () => {
    const gate = canPublishDirectly(codeDiff, "open");
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  test("smart policy allows a deco-only payload without the judge", () => {
    expect(canPublishDirectly(decoDiff, "smart").allowed).toBe(true);
  });
});

describe("reviewDiffSignature", () => {
  test("is stable for the same diff", () => {
    const diff: GitDiffResult = {
      diffs: { "routes/a.tsx": { from: "a", to: "b" } },
    };
    expect(reviewDiffSignature(diff)).toBe(reviewDiffSignature(diff));
  });

  test("is order-independent across paths", () => {
    const a: GitDiffResult = {
      diffs: {
        "a.tsx": { from: "1", to: "2" },
        "b.tsx": { from: "3", to: "4" },
      },
    };
    const b: GitDiffResult = {
      diffs: {
        "b.tsx": { from: "3", to: "4" },
        "a.tsx": { from: "1", to: "2" },
      },
    };
    expect(reviewDiffSignature(a)).toBe(reviewDiffSignature(b));
  });

  // The safety case: a length-preserving edit deep in a file (past a short
  // prefix) must still change the signature, or a stale "allowed" verdict would
  // be reused for code that now needs review (fail-open).
  test("changes for a length-preserving deep edit", () => {
    const prefix = "x".repeat(80);
    const before: GitDiffResult = {
      diffs: { "routes/api.tsx": { from: "", to: `${prefix}LIMIT=1000` } },
    };
    const after: GitDiffResult = {
      diffs: { "routes/api.tsx": { from: "", to: `${prefix}LIMIT=5000` } },
    };
    expect(reviewDiffSignature(before)).not.toBe(reviewDiffSignature(after));
  });

  test("changes when a path is added or removed", () => {
    const one: GitDiffResult = { diffs: { "a.tsx": { from: "1", to: "2" } } };
    const two: GitDiffResult = {
      diffs: {
        "a.tsx": { from: "1", to: "2" },
        "b.tsx": { from: null, to: "3" },
      },
    };
    expect(reviewDiffSignature(one)).not.toBe(reviewDiffSignature(two));
  });

  test("distinguishes a from/to swap of equal-length content", () => {
    const a: GitDiffResult = { diffs: { "a.tsx": { from: "ab", to: "cd" } } };
    const b: GitDiffResult = { diffs: { "a.tsx": { from: "cd", to: "ab" } } };
    expect(reviewDiffSignature(a)).not.toBe(reviewDiffSignature(b));
  });
});

describe("normalizePublishPolicy", () => {
  test("defaults unknown/absent values to smart", () => {
    expect(DEFAULT_PUBLISH_POLICY).toBe("smart");
    expect(normalizePublishPolicy(undefined)).toBe("smart");
    expect(normalizePublishPolicy(null)).toBe("smart");
    expect(normalizePublishPolicy("bogus")).toBe("smart");
  });

  test("passes through valid values", () => {
    expect(normalizePublishPolicy("smart")).toBe("smart");
    expect(normalizePublishPolicy("code-review")).toBe("code-review");
    expect(normalizePublishPolicy("open")).toBe("open");
  });
});

describe("needsSmartReviewJudgment", () => {
  const decoDiff: GitDiffResult = {
    diffs: { ".deco/blocks/home.json": { from: "{}", to: "{}" } },
  };
  const codeDiff: GitDiffResult = {
    diffs: { "routes/index.tsx": { from: "a", to: "b" } },
  };

  test("only smart policy with code needs the judge", () => {
    expect(needsSmartReviewJudgment(codeDiff, "smart")).toBe(true);
    expect(needsSmartReviewJudgment(decoDiff, "smart")).toBe(false);
    expect(needsSmartReviewJudgment(codeDiff, "code-review")).toBe(false);
    expect(needsSmartReviewJudgment(codeDiff, "open")).toBe(false);
  });

  test("empty/null diffs never need the judge", () => {
    expect(needsSmartReviewJudgment(null, "smart")).toBe(false);
    expect(needsSmartReviewJudgment({ diffs: {} }, "smart")).toBe(false);
  });
});

describe("smartReviewGate", () => {
  test("blocks (pending) while the judge is still running", () => {
    const gate = smartReviewGate(null, true);
    expect(gate.allowed).toBe(false);
    expect(gate.pending).toBe(true);
    // Copy is i18n'd at the component level, so no inline reason here.
    expect(gate.reason).toBeNull();
  });

  test("permissive when the judge is unavailable (no verdict)", () => {
    const gate = smartReviewGate(null, false);
    expect(gate.allowed).toBe(true);
    expect(gate.pending).toBeUndefined();
  });

  test("allows when the verdict says no review needed", () => {
    const gate = smartReviewGate({ requiresReview: false, reason: "" }, false);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  test("blocks with the AI reason when review is required", () => {
    const gate = smartReviewGate(
      { requiresReview: true, reason: "New API endpoint added" },
      false,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("New API endpoint added");
  });

  test("blocks with a null reason when the AI gives no reason (UI localizes)", () => {
    const gate = smartReviewGate({ requiresReview: true, reason: "" }, false);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBeNull();
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
    expect(gate.reason).toBeNull();
  });
});

describe("isDecoOnlyPaths", () => {
  test("accepts CMS JSON at the repo root and under a package path", () => {
    expect(isDecoOnlyPaths([".deco/blocks/Home.json"])).toBe(true);
    expect(isDecoOnlyPaths(["apps/site/.deco/blocks/Home.json"])).toBe(true);
  });

  test("accepts generated artifacts alongside CMS JSON", () => {
    expect(
      isDecoOnlyPaths([".deco/blocks/Home.json", "static/tailwind.css"]),
    ).toBe(true);
  });

  test("rejects the list as soon as one path is code", () => {
    expect(
      isDecoOnlyPaths([".deco/blocks/Home.json", "site/sections/Hero.tsx"]),
    ).toBe(false);
  });

  test("an empty list is not deco-only — nothing is known yet", () => {
    expect(isDecoOnlyPaths([])).toBe(false);
  });
});

describe("resolvePathGate", () => {
  const DECO = [".deco/blocks/Home.json"];
  const CODE = [".deco/blocks/Home.json", "site/sections/Hero.tsx"];

  test("open publishes anything", () => {
    expect(resolvePathGate(DECO, "open").allowed).toBe(true);
    expect(resolvePathGate(CODE, "open").allowed).toBe(true);
  });

  test("deco-only publishes under every policy", () => {
    expect(resolvePathGate(DECO, "smart").allowed).toBe(true);
    expect(resolvePathGate(DECO, "code-review").allowed).toBe(true);
  });

  test("code under code-review is blocked outright, not pending", () => {
    const gate = resolvePathGate(CODE, "code-review");
    expect(gate.allowed).toBe(false);
    expect(gate.pending).toBeUndefined();
  });

  test("code under smart is PENDING — the judge has not run yet", () => {
    const gate = resolvePathGate(CODE, "smart");
    expect(gate.allowed).toBe(false);
    expect(gate.pending).toBe(true);
  });

  test("an unknown path list never resolves to allowed", () => {
    for (const policy of ["smart", "code-review", "open"] as const) {
      expect(resolvePathGate([], policy).allowed).toBe(false);
    }
  });
});

describe("sandboxGitStatusQueryOptions", () => {
  const REF = {
    orgSlug: "org",
    virtualMcpId: "vm",
    branch: "feat",
    threadId: "thrd_1",
  };

  test("shares one cache entry with sandboxGitStatusQueryKey", () => {
    expect(sandboxGitStatusQueryOptions(REF).queryKey).toEqual(
      sandboxGitStatusQueryKey(REF),
    );
  });

  test("carries the 5s staleness budget the header and popover both rely on", () => {
    expect(sandboxGitStatusQueryOptions(REF).staleTime).toBe(5_000);
  });

  // Two sessions can share a branch, and they get different answers from the
  // same URL — so they must not share one cache entry.
  test("two threads on one branch key separately", () => {
    expect(sandboxGitStatusQueryKey(REF)).not.toEqual(
      sandboxGitStatusQueryKey({ ...REF, threadId: "thrd_2" }),
    );
  });
});

describe("hasNothingToReview", () => {
  test("false for an absent status — unknown is not empty", () => {
    expect(hasNothingToReview(null)).toBe(false);
    expect(hasNothingToReview(undefined)).toBe(false);
  });

  test("true for a pristine branch", () => {
    expect(hasNothingToReview(cleanStatus)).toBe(true);
  });

  test("true when only generated artifacts changed", () => {
    expect(
      hasNothingToReview({ ...cleanStatus, modified: ["blocks.gen.json"] }),
    ).toBe(true);
  });

  test("false once there is real work, a commit ahead of base, or an unpushed commit", () => {
    expect(
      hasNothingToReview({ ...cleanStatus, modified: ["src/app.tsx"] }),
    ).toBe(false);
    expect(hasNothingToReview({ ...cleanStatus, aheadOfBase: 1 })).toBe(false);
    expect(hasNothingToReview({ ...cleanStatus, unpushed: 1 })).toBe(false);
  });
});

describe("fetchGitStatus with a malformed response body", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("surfaces a SandboxGitError instead of a raw SyntaxError", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("<html>Bad Gateway</html>", { status: 502 }),
      )) as unknown as typeof fetch;

    const error = await fetchGitStatus({
      orgSlug: "org",
      virtualMcpId: "vm",
      branch: "feat",
      threadId: null,
    }).catch((e) => e);
    expect(isSandboxUnreachable(error)).toBe(false);
    expect(error).toHaveProperty("status", 502);
    expect(error.message).toBe("Request failed (502)");
  });
});
