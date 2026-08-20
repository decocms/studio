import { describe, expect, test } from "bun:test";
import type { BranchMeta, LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/components/sandbox/hooks/sandbox-events-context";
import { selectHeaderButton, type HeaderButton } from "./panel-state";
import type { CheckRun, PrSummary } from "./use-pr-data";
import type { PrReviewSignals } from "./use-pr-reviews";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { InterpolationVars } from "@/i18n/interpolate.ts";
import { thread as threadEn } from "@/i18n/en/thread.ts";

const mockT: TFunction = (key: TranslationKey, vars?: InterpolationVars) => {
  const template =
    (threadEn as Record<string, string>)[key as string] ?? (key as string);
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replace(`{${k}}`, String(v)),
    template,
  );
};

type ReadyBranch = Extract<BranchMeta, { kind: "ready" }>;

const RUNNING_LIFECYCLE: LifecycleState = {
  phase: "running",
  port: 3000,
  htmlSupport: true,
};

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
  claimPhase: ClaimPhase | null;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  loading?: boolean;
  t: TFunction;
}

function happyInput(over: Partial<BaseInput> = {}): BaseInput {
  return {
    lifecycle: RUNNING_LIFECYCLE,
    branch: ready(),
    claimPhase: null,
    pr: null,
    checks: [],
    reviews: null,
    t: mockT,
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
    headRepoFullName: "acme/web",
    htmlUrl: "https://github.com/acme/web/pull/42",
    author: "me",
    changedFiles: 3,
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

function menuKeys(button: HeaderButton): string[] {
  return button.menu.map((item) => item.key);
}

function menuItem(button: HeaderButton, key: string) {
  return button.menu.find((item) => item.key === key);
}

describe("selectHeaderButton", () => {
  test("loading flag → Loading… (disabled, spinner, empty menu)", () => {
    const r = selectHeaderButton(happyInput({ loading: true }));
    expect(r.label).toBe("Loading…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
    expect(r.menu).toEqual([]);
  });

  test("lifecycle.idle → 'Preparing sandbox…' (disabled, spinner)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: null,
      }),
    );
    expect(r.label).toBe("Preparing sandbox…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.variant).toBe("outline");
  });

  test("idle + claimPhase = waiting-for-capacity → 'Waiting for capacity'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "waiting-for-capacity", since: 0 },
      }),
    );
    expect(r.label).toBe("Waiting for capacity");
  });

  test("idle + claimPhase = pulling-image → 'Downloading image'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "pulling-image", since: 0 },
      }),
    );
    expect(r.label).toBe("Downloading image");
  });

  test("idle + claimPhase = starting-container → 'Starting container'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "starting-container", since: 0 },
      }),
    );
    expect(r.label).toBe("Starting container");
  });

  test("idle + claimPhase = warming-daemon → 'Connecting to sandbox'", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "warming-daemon", since: 0 },
      }),
    );
    expect(r.label).toBe("Connecting to sandbox");
  });

  test("idle + claimPhase = ready → 'Preparing sandbox…' (generic)", () => {
    // ready = claim handle up but lifecycle hasn't emitted yet; generic copy.
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "ready" },
      }),
    );
    expect(r.label).toBe("Preparing sandbox…");
  });

  test("idle + claimPhase = claiming → 'Preparing sandbox…' (generic)", () => {
    // `claiming` is absent from `idleClaimCopy` — falls through to generic.
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "idle" },
        branch: { kind: "unknown" },
        claimPhase: { kind: "claiming", since: 0 },
      }),
    );
    expect(r.label).toBe("Preparing sandbox…");
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

  // Setup phases hold the header; failure phases fall through to git/PR logic: git works even when the dev server can't run.

  test("lifecycle.installing + dirty branch → Installing packages… (not publishable yet)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "installing" },
        branch: ready({ workingTreeDirty: true }),
      }),
    );
    expect(r.label).toBe("Installing packages…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.menu).toEqual([]);
  });

  test("lifecycle.starting + clean ready branch → Starting app…", () => {
    const r = selectHeaderButton(
      happyInput({ lifecycle: { phase: "starting" } }),
    );
    expect(r.label).toBe("Starting app…");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
  });

  test("lifecycle.install-failed + dirty branch → Review & Publish (commit fixes)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "install-failed", error: "ENOENT package.json" },
        branch: ready({ workingTreeDirty: true }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
  });

  test("lifecycle.start-failed + ahead-of-base → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "start-failed", error: "exit 1" },
        branch: ready({ aheadOfBase: 3 }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
  });

  test("lifecycle.crashed + dirty branch → Review & Publish (push hotfix)", () => {
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "crashed" },
        branch: ready({ workingTreeDirty: true }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
  });

  test("running with branch still unknown → Loading branch… (defensive)", () => {
    // Window between the app coming up and the daemon's `branch` event.
    const r = selectHeaderButton(
      happyInput({
        lifecycle: { phase: "running", port: 3000, htmlSupport: true },
        branch: { kind: "unknown" },
      }),
    );
    expect(r.label).toBe("Loading branch…");
    expect(r.loading).toBe(true);
  });

  test("no diff anywhere → Up to date (disabled, outline, empty menu)", () => {
    const r = selectHeaderButton(happyInput());
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
    expect(r.menu).toEqual([]);
  });

  /** A branch behind base is not up to date — that label would be a lie. */
  test("behind base → Get latest as the primary, not a disabled pill", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ behindBase: 2 }) }),
    );
    expect(r.label).toBe("Get latest");
    expect(r.action).toBe("sync");
    expect(r.variant).toBe("default");
    expect(r.disabled).toBeFalsy();
    expect(menuKeys(r)).toEqual([]);
  });

  test("dirty working tree → Review & Publish with Submit for review in the menu", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ workingTreeDirty: true }) }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.variant).toBe("brand");
    expect(r.disabled).toBeFalsy();
    // Unreviewed local work must NOT bypass the publish policy gate.
    expect(r.meta?.publishPolicyOverride).toBeUndefined();
    expect(menuKeys(r)).toEqual(["submit-for-review"]);
    expect(menuItem(r, "submit-for-review")?.action).toBe("create-pr");
  });

  test("dirty + open PR + behind base → menu also offers GitHub link and Get latest", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ workingTreeDirty: true, behindBase: 1 }),
        pr: pr(),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(menuKeys(r)).toEqual([
      "submit-for-review",
      "view-on-github",
      "get-latest",
    ]);
  });

  test("unpushed commits ahead of base with no PR → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ unpushed: 2, aheadOfBase: 2 }) }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(menuKeys(r)).toEqual(["submit-for-review"]);
  });

  test("unpushed commits without base divergence and no PR → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ unpushed: 2, aheadOfBase: 0 }) }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
  });

  test("unpushed commits with open PR (different head) → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ unpushed: 2, aheadOfBase: 2, headSha: "local999" }),
        pr: pr({ headSha: "remote888" }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.meta?.publishPolicyOverride).toBeUndefined();
  });

  test("false-positive unpushed (headSha matches PR) → publishable PR state", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ unpushed: 1, aheadOfBase: 1, headSha: "abc123" }),
        pr: pr({ headSha: "abc123" }),
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.variant).toBe("brand");
    // PR cleared every header gate — the dialog must not re-gate by content.
    expect(r.meta?.publishPolicyOverride).toBe("open");
    expect(menuKeys(r)).toEqual(["review", "view-on-github"]);
  });

  test("ahead of base + closed non-merged PR → Reopen PR", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr({ state: "closed", merged: false }),
      }),
    );
    expect(r.label).toBe("Reopen PR");
    expect(r.action).toBe("reopen");
    expect(menuKeys(r)).toEqual(["view-on-github"]);
  });

  test("merged PR, branch at merge head → Up to date (disabled, GitHub link)", () => {
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
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.variant).toBe("outline");
    expect(r.tooltip).toBe("PR #42 merged into main");
    expect(menuKeys(r)).toEqual(["view-on-github"]);
  });

  /** Publishing is done, so syncing this branch is not the next step. */
  test("merged PR behind base stays Up to date, Get latest in the menu", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3, behindBase: 2, headSha: "abc123" }),
        pr: pr({
          state: "closed",
          merged: true,
          mergedAt: "2026-04-22T00:00:00Z",
          headSha: "abc123",
        }),
      }),
    );
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.tooltip).toBe("PR #42 merged into main");
    expect(menuKeys(r)).toEqual(["view-on-github", "get-latest"]);
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
    expect(menuKeys(r)).toEqual(["view-on-github"]);
  });

  test("ahead of base + no PR → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({ branch: ready({ aheadOfBase: 3 }) }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(menuKeys(r)).toEqual(["submit-for-review"]);
  });

  test("PR open + mergeable_state=dirty → Get latest with Resolve on GitHub", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Get latest");
    expect(r.action).toBe("rebase");
    expect(menuKeys(r)).toEqual(["resolve-on-github"]);
    expect(menuItem(r, "resolve-on-github")?.action).toBe("open-pr-page");
  });

  test("PR open + settled failed check → Fix checks with failing list and Publish anyway", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ conclusion: "failure", name: "unit-test" })],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Fix checks");
    expect(r.action).toBe("fix-checks");
    expect(r.meta?.failingChecks).toEqual(["unit-test"]);
    expect(menuKeys(r)).toEqual(["publish-anyway", "view-on-github"]);
    expect(menuItem(r, "publish-anyway")?.action).toBe("merge");
    expect(menuItem(r, "publish-anyway")?.label).toBe("Publish anyway");
  });

  test("PR open + check in-progress → Review & Publish stays clickable with progress tooltip", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ status: "in_progress", conclusion: null })],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.disabled).toBeFalsy();
    expect(r.loading).toBeFalsy();
    expect(r.tooltip).toBe("Running checks 0 of 1 done");
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

  test("PR open + missing approvals → Waiting for review opens the PR page", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        reviews: reviews({ missingRequiredApprovals: true }),
      }),
    );
    expect(r.label).toBe("Waiting for review");
    expect(r.disabled).toBeFalsy();
    expect(r.action).toBe("open-pr-page");
    expect(r.variant).toBe("outline");
  });

  test("PR open + all clear → Review & Publish with Review and GitHub link", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check()],
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.variant).toBe("brand");
    expect(r.meta?.publishPolicyOverride).toBe("open");
    expect(menuKeys(r)).toEqual(["review", "view-on-github"]);
    expect(menuItem(r, "review")?.action).toBe("review");
  });

  test("PR open + reviews still loading → Review & Publish", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr(),
        checks: [check()],
        reviews: null,
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
  });

  test("priority: dirty beats open-PR states", () => {
    const r = selectHeaderButton(
      happyInput({
        branch: ready({ workingTreeDirty: true, aheadOfBase: 3 }),
        pr: pr(),
        checks: [check({ conclusion: "failure" })],
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    // Local-work state: menu has Submit for review, and no policy bypass.
    expect(r.label).toBe("Review & Publish");
    expect(r.meta?.publishPolicyOverride).toBeUndefined();
    expect(menuKeys(r)).toContain("submit-for-review");
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
    expect(r.label).toBe("Get latest");
  });

  test("priority: in-progress checks beat failed checks (failure set not final)", () => {
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
    // Fast Preview rule: while anything runs, red isn't final — no Fix checks yet.
    expect(r.label).toBe("Review & Publish");
    expect(r.tooltip).toBe("Running checks 1 of 2 done");
  });
});
