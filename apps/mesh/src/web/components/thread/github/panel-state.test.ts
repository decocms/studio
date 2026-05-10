import { describe, expect, test } from "bun:test";
import type {
  BranchMeta,
  DaemonStatus,
  LifecycleState,
} from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/web/components/vm/hooks/vm-events-context";
import { selectHeaderButton } from "./panel-state";
import type { CheckRun, PrSummary } from "./use-pr-data";
import type { PrReviewSignals } from "./use-pr-reviews";

type ReadyBranch = Extract<BranchMeta, { kind: "ready" }>;

const RUNNING_LIFECYCLE: LifecycleState = {
  phase: "running",
  port: 3000,
  htmlSupport: true,
};
const RUNNING_STATUS: DaemonStatus = { state: "running" };

function ready(over: Partial<ReadyBranch> = {}): ReadyBranch {
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

interface BaseInput {
  lifecycle: LifecycleState;
  branch: BranchMeta;
  status: DaemonStatus;
  claimPhase: ClaimPhase | null;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  loading?: boolean;
}

function happyInput(over: Partial<BaseInput> = {}): BaseInput {
  return {
    lifecycle: RUNNING_LIFECYCLE,
    branch: ready(),
    status: RUNNING_STATUS,
    claimPhase: null,
    pr: null,
    checks: [],
    reviews: null,
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
  test("loading flag → Loading… (disabled, spinner)", () => {
    const r = selectHeaderButton(happyInput({ loading: true }));
    expect(r.label).toBe("Loading…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("lifecycle.idle → 'Starting sandbox…' (disabled, spinner)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: null,
      }),
    );
    expect(r.label).toBe("Starting sandbox…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("lifecycle.cloning → 'Cloning repo…' (disabled, spinner)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "cloning" },
        branch: { kind: "unknown" },
      }),
    );
    expect(r.label).toBe("Cloning repo…");
    expect(r.loading).toBe(true);
  });

  test("lifecycle.clone-failed → 'Clone failed' with error tooltip", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "clone-failed", error: "exit 128" },
        branch: { kind: "unknown" },
      }),
    );
    expect(r.label).toBe("Clone failed");
    expect(r.disabled).toBe(true);
    expect(r.tooltip).toBe("exit 128");
  });

  test("lifecycle.checking-out → 'Switching to <branch>…'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "checking-out", to: "feat/y" },
        branch: { kind: "unknown" },
      }),
    );
    expect(r.label).toBe("Switching to feat/y…");
    expect(r.loading).toBe(true);
  });

  test("lifecycle.installing → 'Installing packages…'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "installing" },
        branch: { kind: "unknown" },
      }),
    );
    expect(r.label).toBe("Installing packages…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("no diff anywhere → Up to date (disabled, outline)", () => {
    const r = selectHeaderButton(happyInput());
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("dirty working tree → Save changes", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ workingTreeDirty: true }) }),
    );
    expect(r.label).toBe("Save changes");
    expect(r.action).toBe("commit-and-push");
    expect(r.disabled).toBeFalsy();
  });

  test("unpushed commits → Save changes", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ unpushed: 2 }) }),
    );
    expect(r.label).toBe("Save changes");
  });

  test("ahead of base + closed non-merged PR → Reopen PR", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr({ state: "closed", merged: false }),
      }),
    );
    expect(r.label).toBe("Reopen");
    expect(r.action).toBe("reopen");
  });

  test("merged PR, branch at merge head → Published (disabled, outline)", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3, headSha: "abc123" }),
        pr: pr({
          state: "closed",
          merged: true,
          mergedAt: "2026-04-22T00:00:00Z",
          headSha: "abc123",
        }),
      }),
    );
    expect(r.label).toBe("Published");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("merged PR, branch advanced past merge head → Continue (special)", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 4, headSha: "def456" }),
        pr: pr({
          state: "closed",
          merged: true,
          mergedAt: "2026-04-22T00:00:00Z",
          headSha: "abc123",
        }),
      }),
    );
    expect(r.label).toBe("Continue");
    expect(r.action).toBe("create-pr");
    expect(r.variant).toBe("special");
  });

  test("ahead of base + no PR → Submit for review", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ aheadOfBase: 3 }) }),
    );
    expect(r.label).toBe("Submit for review");
  });

  test("PR open + mergeable_state=dirty → Sync with main", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Sync with main");
    expect(r.action).toBe("rebase");
  });

  test("PR open + failed check → Fix tests with failing list", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ conclusion: "failure", name: "unit-test" })],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Fix tests");
    expect(r.action).toBe("fix-checks");
    expect(r.meta?.failingChecks).toEqual(["unit-test"]);
  });

  test("PR open + check in-progress → Running tests…", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ status: "in_progress", conclusion: null })],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Running tests…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("PR open + draft → Mark ready", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ draft: true }),
      }),
    );
    expect(r.label).toBe("Mark ready");
    expect(r.action).toBe("mark-ready");
  });

  test("PR open + unresolved conversations → Address feedback", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ unresolvedConversations: 2 }),
      }),
    );
    expect(r.label).toBe("Address feedback");
    expect(r.action).toBe("resolve-comments");
  });

  test("PR open + missing approvals → Awaiting review", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ missingRequiredApprovals: true }),
      }),
    );
    expect(r.label).toBe("Awaiting review");
    expect(r.disabled).toBe(true);
  });

  test("PR open + all clear → Publish", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check()],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Publish");
    expect(r.action).toBe("merge-split");
    expect(r.variant).toBe("success");
  });

  test("priority: dirty beats everything else", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ workingTreeDirty: true, aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ conclusion: "failure" })],
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Save changes");
  });

  test("priority inside PR open: conflicts beat failed checks", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ conclusion: "failure" })],
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Sync with main");
  });

  test("priority: failed checks beat in-progress checks", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [
          check({ conclusion: "failure", name: "lint" }),
          check({ status: "in_progress", conclusion: null, name: "unit-test" }),
        ],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Fix tests");
  });
});
