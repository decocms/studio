import { describe, expect, test } from "bun:test";
import type {
  BranchStatus,
  BranchStatusReady,
} from "@/web/components/vm/hooks/use-vm-events";
import { selectHeaderButton } from "./panel-state";
import type { CheckRun, PrSummary } from "./use-pr-data";
import type { PrReviewSignals } from "./use-pr-reviews";

function bs(over: Partial<BranchStatusReady> = {}): BranchStatusReady {
  return {
    kind: "ready",
    branch: "feat/x",
    base: "main",
    workingTreeDirty: false,
    unpushed: 0,
    aheadOfBase: 0,
    behindBase: 0,
    headSha: "abc123",
    ...over,
  };
}

function pr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    title: "Add X",
    body: "",
    state: "open",
    merged: false,
    mergedAt: null,
    base: "main",
    head: "feat/x",
    headSha: "abc123",
    htmlUrl: "https://github.com/acme/web/pull/42",
    author: "me",
    ...over,
  };
}

function check(over: Partial<CheckRun> = {}): CheckRun {
  return {
    id: "1",
    name: "lint",
    status: "completed",
    conclusion: "success",
    htmlUrl: "",
    durationMs: null,
    ...over,
  };
}

function reviews(over: Partial<PrReviewSignals> = {}): PrReviewSignals {
  return {
    draft: false,
    mergeableState: "clean",
    unresolvedConversations: 0,
    missingRequiredApprovals: false,
    ...over,
  };
}

describe("selectHeaderButton", () => {
  test("branchStatus missing → Loading… (disabled, spinner)", () => {
    const r = selectHeaderButton({
      branchStatus: null,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Loading…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("loading flag → Loading… even when branchStatus present", () => {
    const r = selectHeaderButton({
      branchStatus: bs(),
      pr: null,
      checks: [],
      reviews: null,
      loading: true,
    });
    expect(r.label).toBe("Loading…");
    expect(r.loading).toBe(true);
  });

  test("kind=initializing → 'Starting sandbox…' (disabled, spinner)", () => {
    const r = selectHeaderButton({
      branchStatus: { kind: "initializing" } as BranchStatus,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Starting sandbox…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("kind=cloning → 'Cloning repo…' (disabled, spinner)", () => {
    const r = selectHeaderButton({
      branchStatus: { kind: "cloning" } as BranchStatus,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Cloning repo…");
    expect(r.loading).toBe(true);
  });

  test("kind=clone-failed → 'Clone failed' with error tooltip", () => {
    const r = selectHeaderButton({
      branchStatus: { kind: "clone-failed", error: "exit 128" } as BranchStatus,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Clone failed");
    expect(r.disabled).toBe(true);
    expect(r.tooltip).toBe("exit 128");
  });

  test("kind=checking-out → 'Switching to <branch>…'", () => {
    const r = selectHeaderButton({
      branchStatus: { kind: "checking-out", to: "feat/y" } as BranchStatus,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Switching to feat/y…");
    expect(r.loading).toBe(true);
  });

  test("kind=checkout-failed → 'Checkout failed' with error tooltip", () => {
    const r = selectHeaderButton({
      branchStatus: {
        kind: "checkout-failed",
        error: "dirty working tree",
      } as BranchStatus,
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Checkout failed");
    expect(r.tooltip).toBe("dirty working tree");
  });

  test("no diff anywhere → Up to date (disabled, outline)", () => {
    const r = selectHeaderButton({
      branchStatus: bs(),
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("dirty working tree → Commit & Push", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ workingTreeDirty: true }),
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Save changes");
    expect(r.action).toBe("commit-and-push");
    expect(r.disabled).toBeFalsy();
  });

  test("unpushed commits → Commit & Push", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ unpushed: 2 }),
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Save changes");
  });

  test("ahead of base + closed non-merged PR → Reopen PR", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr({ state: "closed", merged: false }),
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Reopen");
    expect(r.action).toBe("reopen");
  });

  test("merged PR, branch at merge head → Published (disabled, outline)", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3, headSha: "abc123" }),
      pr: pr({
        state: "closed",
        merged: true,
        mergedAt: "2026-04-22T00:00:00Z",
        headSha: "abc123",
      }),
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Published");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("merged PR, branch advanced past merge head → Continue (special)", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 4, headSha: "def456" }),
      pr: pr({
        state: "closed",
        merged: true,
        mergedAt: "2026-04-22T00:00:00Z",
        headSha: "abc123",
      }),
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Continue");
    expect(r.action).toBe("create-pr");
    expect(r.variant).toBe("special");
  });

  test("ahead of base + no PR → Create PR", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: null,
      checks: [],
      reviews: null,
    });
    expect(r.label).toBe("Submit for review");
  });

  test("PR open + mergeable_state=dirty → Rebase on main", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [],
      reviews: reviews({ mergeableState: "dirty" }),
    });
    expect(r.label).toBe("Sync with main");
    expect(r.action).toBe("rebase");
  });

  test("PR open + failed check → Fix checks with failing list", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [check({ conclusion: "failure", name: "unit-test" })],
      reviews: reviews(),
    });
    expect(r.label).toBe("Fix tests");
    expect(r.action).toBe("fix-checks");
    expect(r.meta?.failingChecks).toEqual(["unit-test"]);
  });

  test("PR open + check in-progress → Waiting for checks (disabled)", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [check({ status: "in_progress", conclusion: null })],
      reviews: reviews(),
    });
    expect(r.label).toBe("Running tests…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("PR open + draft → Mark ready for review", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [],
      reviews: reviews({ draft: true }),
    });
    expect(r.label).toBe("Mark ready");
    expect(r.action).toBe("mark-ready");
  });

  test("PR open + unresolved conversations → Resolve review comments", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [],
      reviews: reviews({ unresolvedConversations: 2 }),
    });
    expect(r.label).toBe("Address feedback");
    expect(r.action).toBe("resolve-comments");
  });

  test("PR open + missing approvals → Waiting for review (disabled)", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [],
      reviews: reviews({ missingRequiredApprovals: true }),
    });
    expect(r.label).toBe("Awaiting review");
    expect(r.disabled).toBe(true);
  });

  test("PR open + all clear → Merge", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [check()],
      reviews: reviews(),
    });
    expect(r.label).toBe("Publish");
    expect(r.action).toBe("merge-split");
    expect(r.variant).toBe("success");
  });

  test("priority: dirty beats everything else", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ workingTreeDirty: true, aheadOfBase: 3 }),
      pr: pr(),
      checks: [check({ conclusion: "failure" })],
      reviews: reviews({ mergeableState: "dirty" }),
    });
    expect(r.label).toBe("Save changes");
  });

  test("priority inside PR open: conflicts beat failed checks", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [check({ conclusion: "failure" })],
      reviews: reviews({ mergeableState: "dirty" }),
    });
    expect(r.label).toBe("Sync with main");
  });

  test("priority: failed checks beat in-progress checks", () => {
    const r = selectHeaderButton({
      branchStatus: bs({ aheadOfBase: 3 }),
      pr: pr(),
      checks: [
        check({ conclusion: "failure", name: "lint" }),
        check({ status: "in_progress", conclusion: null, name: "unit-test" }),
      ],
      reviews: reviews(),
    });
    expect(r.label).toBe("Fix tests");
  });
});
