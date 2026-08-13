import { describe, expect, test } from "bun:test";
import type { BranchMeta } from "@decocms/sandbox/shared";
import {
  selectCmsHeaderButton,
  type SelectCmsHeaderButtonInput,
} from "./cms-panel-state";
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

/**
 * Fast Preview has no working tree: `workingTreeDirty` and `unpushed` are
 * pinned to their empty values here because the daemon never reports anything
 * else in this mode.
 */
function ready(over: Partial<ReadyBranch> = {}): ReadyBranch {
  return {
    kind: "ready",
    branch: "content/x",
    base: "main",
    workingTreeDirty: false,
    unpushed: 0,
    aheadOfBase: 0,
    behindBase: 0,
    headSha: "abc123",
    ...over,
  };
}

function input(
  over: Partial<SelectCmsHeaderButtonInput> = {},
): SelectCmsHeaderButtonInput {
  return {
    branch: ready(),
    pr: null,
    checks: [],
    reviews: null,
    publishing: false,
    saving: false,
    loading: false,
    t: mockT,
    ...over,
  };
}

function pr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    title: "Update homepage copy",
    body: "",
    state: "open",
    merged: false,
    mergedAt: null,
    base: "main",
    head: "content/x",
    headSha: "abc123",
    headRepoFullName: "acme/web",
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

const running = check({
  id: "2",
  name: "build",
  status: "in_progress",
  conclusion: null,
});
const failed = check({ id: "3", name: "unit", conclusion: "failure" });

function menuKeys(menu: { key: string }[]): string[] {
  return menu.map((m) => m.key);
}

describe("selectCmsHeaderButton — 1. loading", () => {
  test("loading flag → Loading… (disabled, spinner, no menu)", () => {
    const r = selectCmsHeaderButton(input({ loading: true }));
    expect(r.label).toBe("Loading…");
    expect(r.variant).toBe("outline");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.menu).toEqual([]);
  });

  test("branch not ready → Loading…", () => {
    const r = selectCmsHeaderButton(input({ branch: { kind: "unknown" } }));
    expect(r.label).toBe("Loading…");
    expect(r.loading).toBe(true);
  });

  test("loading beats publishing", () => {
    const r = selectCmsHeaderButton(input({ loading: true, publishing: true }));
    expect(r.label).toBe("Loading…");
  });

  test("branch not ready beats an open PR ready to publish", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: { kind: "unknown" },
        pr: pr(),
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Loading…");
  });
});

describe("selectCmsHeaderButton — 2. publishing", () => {
  test("publishing → Publishing… (disabled, spinner, no menu)", () => {
    const r = selectCmsHeaderButton(input({ publishing: true }));
    expect(r.label).toBe("Publishing…");
    expect(r.variant).toBe("outline");
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.menu).toEqual([]);
  });

  test("publishing beats every PR state, including conflicts", () => {
    const r = selectCmsHeaderButton(
      input({
        publishing: true,
        branch: ready({ aheadOfBase: 2, behindBase: 3 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Publishing…");
    expect(r.menu).toEqual([]);
  });
});

describe("selectCmsHeaderButton — 3. needs attention (conflicts)", () => {
  test("open PR + dirty → Get latest with Resolve on GitHub menu", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(r.label).toBe("Get latest");
    expect(r.action).toBe("get-latest");
    expect(r.variant).toBe("default");
    expect(r.tooltip).toBe("Bring in new changes from production");
    expect(r.menu).toEqual([
      {
        key: "resolve-on-github",
        label: "Resolve on GitHub",
        action: "open-pr",
      },
    ]);
  });

  test("conflicts beat draft and beat failing checks", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [failed],
        reviews: reviews({ mergeableState: "dirty", draft: true }),
      }),
    );
    expect(r.label).toBe("Get latest");
    expect(r.variant).toBe("default");
    expect(r.tooltip).toBe("Bring in new changes from production");
  });

  test("conflicts + behind base → no duplicate Get latest in the menu", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2, behindBase: 5 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "dirty" }),
      }),
    );
    expect(menuKeys(r.menu)).toEqual(["resolve-on-github"]);
  });
});

describe("selectCmsHeaderButton — 4. waiting for approval", () => {
  test("open PR + blocked → Waiting for review (opens the PR)", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.label).toBe("Waiting for review");
    expect(r.action).toBe("open-pr");
    expect(r.variant).toBe("outline");
    expect(r.disabled).toBeFalsy();
    expect(r.menu).toEqual([
      { key: "view-on-github", label: "View on GitHub", action: "open-pr" },
    ]);
  });

  test("open PR + draft (clean mergeable state) → Waiting for review", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews({ draft: true }),
      }),
    );
    expect(r.label).toBe("Waiting for review");
    expect(r.action).toBe("open-pr");
  });

  test("no checks → outline, no spinner, no pulse, no tooltip", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.variant).toBe("outline");
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
    expect(r.tooltip).toBeUndefined();
  });

  test("all checks passed → outline, no spinner, no pulse", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), check({ id: "9", name: "types" })],
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.variant).toBe("outline");
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
    expect(r.tooltip).toBeUndefined();
  });

  test("check running → spinner (not pulse) + progress tooltip", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), running],
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.loading).toBe(true);
    expect(r.pulse).toBeFalsy();
    expect(r.tooltip).toBe("Running checks 1 of 2 done");
    expect(r.variant).toBe("outline");
  });

  test("check failed, none running → warning + failing tooltip, not disabled", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), failed],
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.variant).toBe("warning");
    expect(r.tooltip).toBe("1 of 2 checks are not passing");
    expect(r.disabled).toBeFalsy();
    expect(r.action).toBe("open-pr");
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
  });

  test("mixed failed + running → running wins (spinner, outline)", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), failed, running],
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(r.loading).toBe(true);
    expect(r.pulse).toBeFalsy();
    expect(r.variant).toBe("outline");
    expect(r.tooltip).toBe("Running checks 2 of 3 done");
  });
});

describe("selectCmsHeaderButton — 5. ready to publish", () => {
  test("open PR + clean → Review & Publish (brand)", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews(),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.variant).toBe("brand");
    expect(r.menu).toEqual([
      { key: "view-on-github", label: "View on GitHub", action: "open-pr" },
    ]);
  });

  test("reviews still loading (null → unknown) → Review & Publish", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 2 }), pr: pr(), reviews: null }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
  });

  test.each(["unstable", "behind", "unknown"] as const)(
    "mergeableState=%s → Review & Publish",
    (mergeableState) => {
      const r = selectCmsHeaderButton(
        input({
          branch: ready({ aheadOfBase: 2 }),
          pr: pr(),
          reviews: reviews({ mergeableState }),
        }),
      );
      expect(r.label).toBe("Review & Publish");
      expect(r.variant).toBe("brand");
    },
  );

  test("no checks → brand, no spinner, no pulse, no tooltip", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        reviews: reviews(),
      }),
    );
    expect(r.variant).toBe("brand");
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
    expect(r.tooltip).toBeUndefined();
  });

  test("all checks passed → brand, no spinner, no pulse", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), check({ id: "9", name: "types" })],
        reviews: reviews(),
      }),
    );
    expect(r.variant).toBe("brand");
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
    expect(r.tooltip).toBeUndefined();
  });

  test("check running → pulse (not spinner) + progress tooltip", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), running],
        reviews: reviews(),
      }),
    );
    expect(r.pulse).toBe(true);
    expect(r.loading).toBeFalsy();
    expect(r.tooltip).toBe("Running checks 1 of 2 done");
    expect(r.variant).toBe("brand");
    expect(r.action).toBe("publish");
  });

  test("check failed, none running → warning overrides brand, still publishable", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [check(), failed, check({ id: "4", conclusion: "timed_out" })],
        reviews: reviews(),
      }),
    );
    expect(r.variant).toBe("warning");
    expect(r.tooltip).toBe("2 of 3 checks are not passing");
    expect(r.action).toBe("publish");
    expect(r.disabled).toBeFalsy();
    expect(r.pulse).toBeFalsy();
  });

  test("mixed failed + running → running wins (pulse, brand)", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2 }),
        pr: pr(),
        checks: [failed, running],
        reviews: reviews(),
      }),
    );
    expect(r.pulse).toBe(true);
    expect(r.loading).toBeFalsy();
    expect(r.variant).toBe("brand");
    expect(r.tooltip).toBe("Running checks 1 of 2 done");
  });
});

describe("selectCmsHeaderButton — 6. draft (no open PR)", () => {
  test("ahead of base, no PR → Review & Publish + Submit for review", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 3 }) }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
    expect(r.variant).toBe("brand");
    expect(r.menu).toEqual([
      {
        key: "request-approval",
        label: "Submit for review",
        action: "request-approval",
      },
    ]);
  });

  test("ahead of a merged PR the branch has moved past → Draft", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 3, headSha: "after-merge" }),
        pr: pr({
          state: "closed",
          merged: true,
          mergedAt: "2026-04-22",
          headSha: "at-merge",
        }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(menuKeys(r.menu)).toEqual(["request-approval"]);
  });

  test("ahead of base + closed PR → Draft", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 3 }),
        pr: pr({ state: "closed", merged: false }),
      }),
    );
    expect(r.label).toBe("Review & Publish");
    expect(r.action).toBe("publish");
  });

  test("checks are ignored without an open PR", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 3 }), checks: [failed, running] }),
    );
    expect(r.variant).toBe("brand");
    expect(r.tooltip).toBeUndefined();
    expect(r.loading).toBeFalsy();
    expect(r.pulse).toBeFalsy();
  });
});

describe("selectCmsHeaderButton — 7. up to date", () => {
  test("nothing ahead, no PR → Up to date (disabled, empty menu)", () => {
    const r = selectCmsHeaderButton(input());
    expect(r.label).toBe("Up to date");
    expect(r.variant).toBe("outline");
    expect(r.disabled).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.menu).toEqual([]);
  });

  test("disabled primary still carries a Get latest menu when behind", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ behindBase: 4 }) }),
    );
    expect(r.label).toBe("Up to date");
    expect(r.disabled).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.menu).toEqual([
      {
        key: "get-latest",
        label: "Get latest",
        action: "get-latest",
        tooltip: "Bring in new changes from production",
      },
    ]);
  });
});

describe("selectCmsHeaderButton — Get latest in every menu when behind", () => {
  test("state 4 (waiting for approval) appends Get latest", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2, behindBase: 1 }),
        pr: pr(),
        reviews: reviews({ mergeableState: "blocked" }),
      }),
    );
    expect(menuKeys(r.menu)).toEqual(["view-on-github", "get-latest"]);
  });

  test("state 5 (ready to publish) appends Get latest", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2, behindBase: 1 }),
        pr: pr(),
        reviews: reviews(),
      }),
    );
    expect(menuKeys(r.menu)).toEqual(["view-on-github", "get-latest"]);
  });

  test("state 6 (draft) appends Get latest", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 2, behindBase: 1 }) }),
    );
    expect(menuKeys(r.menu)).toEqual(["request-approval", "get-latest"]);
  });

  test("state 7 (up to date) appends Get latest", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ behindBase: 1 }) }),
    );
    expect(menuKeys(r.menu)).toEqual(["get-latest"]);
  });

  test("behindBase = 0 → no Get latest anywhere", () => {
    for (const r of [
      selectCmsHeaderButton(
        input({
          branch: ready({ aheadOfBase: 2 }),
          pr: pr(),
          reviews: reviews({ mergeableState: "blocked" }),
        }),
      ),
      selectCmsHeaderButton(
        input({
          branch: ready({ aheadOfBase: 2 }),
          pr: pr(),
          reviews: reviews(),
        }),
      ),
      selectCmsHeaderButton(input({ branch: ready({ aheadOfBase: 2 }) })),
      selectCmsHeaderButton(input()),
    ]) {
      expect(menuKeys(r.menu)).not.toContain("get-latest");
    }
  });

  test("Get latest is appended alongside the check treatment", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2, behindBase: 3 }),
        pr: pr(),
        checks: [failed],
        reviews: reviews(),
      }),
    );
    expect(r.variant).toBe("warning");
    expect(menuKeys(r.menu)).toEqual(["view-on-github", "get-latest"]);
  });
});

describe("saving", () => {
  test("an in-flight block write holds the button", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 2 }), saving: true }),
    );
    expect(r.label).toBe(threadEn["thread.headerActions.saving"]);
    expect(r.disabled).toBe(true);
    expect(r.loading).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.menu).toEqual([]);
  });

  test("Get latest is withheld while saving, even when behind", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ behindBase: 4 }), saving: true }),
    );
    expect(r.menu).toEqual([]);
  });

  test("publishing outranks saving", () => {
    const r = selectCmsHeaderButton(input({ publishing: true, saving: true }));
    expect(r.label).toBe(threadEn["thread.cmsActions.publishing"]);
  });

  test("saving is transparent once the write settles", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 2 }), saving: false }),
    );
    expect(r.label).toBe(threadEn["thread.cmsActions.reviewAndPublish"]);
  });
});

describe("uncommitted work", () => {
  test("a dirty tree with nothing committed is still Draft", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 0, workingTreeDirty: true }) }),
    );
    expect(r.label).toBe(threadEn["thread.cmsActions.reviewAndPublish"]);
    expect(r.action).toBe("publish");
    expect(r.disabled).toBeFalsy();
  });

  test("a clean branch level with base is Up to date", () => {
    const r = selectCmsHeaderButton(
      input({ branch: ready({ aheadOfBase: 0, workingTreeDirty: false }) }),
    );
    expect(r.label).toBe(threadEn["thread.headerActions.upToDate"]);
    expect(r.disabled).toBe(true);
  });

  test("a dirty tree beats a merged PR at the same head", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ headSha: "merged-sha", workingTreeDirty: true }),
        pr: pr({ state: "closed", merged: true, headSha: "merged-sha" }),
      }),
    );
    expect(r.label).toBe(threadEn["thread.cmsActions.reviewAndPublish"]);
    expect(r.action).toBe("publish");
  });
});

describe("merged pull request", () => {
  test("stays 'Up to date' when the branch is level with a merged PR", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 2, headSha: "merged-sha" }),
        pr: pr({ state: "closed", merged: true, headSha: "merged-sha" }),
      }),
    );
    expect(r.label).toBe(threadEn["thread.headerActions.upToDate"]);
    expect(r.disabled).toBe(true);
    expect(r.action).toBeUndefined();
  });

  test("offers to publish again once the branch advances past the merge", () => {
    const r = selectCmsHeaderButton(
      input({
        branch: ready({ aheadOfBase: 3, headSha: "new-sha" }),
        pr: pr({ state: "closed", merged: true, headSha: "merged-sha" }),
      }),
    );
    expect(r.label).toBe(threadEn["thread.cmsActions.reviewAndPublish"]);
    expect(r.action).toBe("publish");
  });
});
