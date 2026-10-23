import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, test } from "bun:test";
import type { BranchMeta } from "@decocms/sandbox/shared";
import { SplitButton } from "@decocms/ui/components/split-button.tsx";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import { en, type TranslationKey } from "@/i18n/en/index.ts";
import { interpolate, type InterpolationVars } from "@/i18n/interpolate.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  hostedCmsHeaderButton,
  hostedHeaderState,
  hostedReleaseBehindMain,
  selectCmsHeaderButton,
  type SelectCmsHeaderButtonInput,
} from "./cms-panel-state";
import type { PrSummary } from "./use-pr-data";

const t: TFunction = (key: TranslationKey, vars?: InterpolationVars) =>
  interpolate(en[key], vars);

const ready = (
  over: Partial<Extract<BranchMeta, { kind: "ready" }>> = {},
): BranchMeta => ({
  kind: "ready",
  branch: "content/x",
  base: "main",
  workingTreeDirty: false,
  unpushed: 0,
  aheadOfBase: 0,
  behindBase: 0,
  headSha: "abc123",
  ...over,
});

const openPr: PrSummary = {
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
  changedFiles: 3,
};

const reviews = (
  over: Partial<NonNullable<SelectCmsHeaderButtonInput["reviews"]>> = {},
) => ({
  draft: false,
  mergeableState: "clean" as const,
  unresolvedConversations: 0,
  missingRequiredApprovals: false,
  ...over,
});

/** One input per state the selector can land on. */
const STATES: Record<string, Partial<SelectCmsHeaderButtonInput>> = {
  retry: { branch: { kind: "unknown" }, statusError: "boom" },
  loading: { loading: true },
  publishing: { publishing: true },
  syncing: { syncing: true },
  saving: { saving: true, branch: ready({ aheadOfBase: 1 }) },
  conflicts: {
    branch: ready({ aheadOfBase: 1 }),
    pr: openPr,
    reviews: reviews({ mergeableState: "dirty" }),
  },
  waitingForReview: {
    branch: ready({ aheadOfBase: 1 }),
    pr: openPr,
    reviews: reviews({ mergeableState: "blocked" }),
  },
  reviewAndPublish: { branch: ready({ aheadOfBase: 1 }) },
  getLatest: { branch: ready({ behindBase: 2 }) },
  upToDate: {},
};

function select(over: Partial<SelectCmsHeaderButtonInput>) {
  return selectCmsHeaderButton({
    branch: ready(),
    pr: null,
    checks: [],
    reviews: null,
    publishing: false,
    saving: false,
    syncing: false,
    statusRetrying: false,
    loading: false,
    statusError: null,
    publishableChangeCount: null,
    t,
    ...over,
  });
}

/** Renders the header's split button the way `CmsHeaderActions` does. */
function renderHeaderButton(button: ReturnType<typeof selectCmsHeaderButton>) {
  return render(
    <TooltipProvider>
      <SplitButton
        size="sm"
        label={button.label}
        variant={button.variant}
        disabled={Boolean(button.disabled) || !button.action}
        loading={Boolean(button.loading)}
        {...(button.tooltip ? { tooltip: button.tooltip } : {})}
        items={button.menu.map((item) => ({
          key: item.key,
          label: item.label,
          onSelect: () => {},
        }))}
        menuAriaLabel="More actions"
      />
    </TooltipProvider>,
  );
}

/**
 * A hosted v8 draft has no secondary actions (no pull request, nothing to
 * sync), so its header button is a plain one: no chevron, in any state, while
 * a v7 (branch) project keeps its split button. Either way the button sizes
 * to its current label: no width is reserved for other states.
 */
describe("hosted v8 header button", () => {
  test.each(Object.keys(STATES))("%s: no menu trigger", (state) => {
    const button = hostedCmsHeaderButton(select(STATES[state] ?? {}));
    expect(button.menu).toEqual([]);
    const view = renderHeaderButton(button);
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(view.getByRole("button", { name: button.label })).toHaveTextContent(
      button.label,
      { normalizeWhitespace: true },
    );
  });

  test("with unpublished work, Review & Publish has no chevron", () => {
    const selected = select(STATES.reviewAndPublish ?? {});
    // The item a hosted draft used to filter out by hand.
    expect(selected.menu.map((item) => item.key)).toEqual(["request-approval"]);
    const view = renderHeaderButton(hostedCmsHeaderButton(selected));
    const primary = view.getByRole("button", {
      name: en["thread.cmsActions.reviewAndPublish"],
    });
    // Only its own label: nothing else reserves width.
    expect(primary.textContent).toBe(en["thread.cmsActions.reviewAndPublish"]);
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  test("v7 keeps the split button and its menu", () => {
    const view = renderHeaderButton(select(STATES.reviewAndPublish ?? {}));
    const trigger = view.getByRole("button", { name: "More actions" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
    // A state with no actions renders no chevron at all.
    view.unmount();
    const upToDate = renderHeaderButton(select({}));
    expect(upToDate.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

describe("hosted v8 header state (changes.list, never git)", () => {
  const list = (names: string[]) => ({
    revision: "c1",
    base: { revision: "m1", resolvedRef: "main" },
    changes: Object.fromEntries(
      names.map((name) => [
        name,
        { kind: "set", version: "v", baseVersion: "b" },
      ]),
    ),
  });
  const button = (names: string[] | undefined) => {
    const state = hostedHeaderState(names ? list(names) : undefined, "draft-1");
    return hostedCmsHeaderButton(
      select({
        branch: state.branchMeta,
        publishableChangeCount: state.publishableChangeCount,
      }),
    );
  };

  test("listed changes are the count: Review & Publish", () => {
    expect(hostedHeaderState(list(["Home", "Footer"]), "draft-1")).toEqual({
      branchMeta: {
        kind: "ready",
        branch: "draft-1",
        base: "main",
        workingTreeDirty: false,
        unpushed: 0,
        aheadOfBase: 2,
        behindBase: 0,
        headSha: "c1",
      },
      publishableChangeCount: 2,
    });
    expect(button(["Home", "Footer"]).label).toBe(
      en["thread.cmsActions.reviewAndPublish"],
    );
  });

  test("no changes: nothing to publish, and nothing to get", () => {
    const empty = button([]);
    expect(empty.label).not.toBe(en["thread.cmsActions.reviewAndPublish"]);
    expect(empty.menu).toEqual([]);
  });

  test("before the list is read: loading, never a git answer", () => {
    expect(hostedHeaderState(undefined, "draft-1")).toEqual({
      branchMeta: { kind: "unknown" },
      publishableChangeCount: null,
    });
  });
});

/**
 * A Publish whose release failed, its "Try again" toast gone (a reload,
 * another editor): the draft lists nothing (its changes are on main), but
 * visitors still see an older release. The header says so calmly and offers
 * Publish, which makes main live; v7 and a v8 sandbox never read it.
 */
describe("hosted v8 header: saved but not live yet", () => {
  const page = (current: string | null, commits: string[]) => ({
    current: current
      ? { revision: current, schemaHash: "h", publishedAt: "t" }
      : null,
    commits: commits.map((sha) => ({ sha })),
  });

  test("behind only when latest.json names a commit other than main's newest", () => {
    expect(hostedReleaseBehindMain(page("m1", ["m2", "m1"]))).toBe(true);
    expect(hostedReleaseBehindMain(page("m2", ["m2", "m1"]))).toBe(false);
    // Never published from Studio: its own build is what visitors see.
    expect(hostedReleaseBehindMain(page(null, ["m2"]))).toBe(false);
    expect(hostedReleaseBehindMain(page("m1", []))).toBe(false);
    // Not read yet: nothing is said.
    expect(hostedReleaseBehindMain(undefined)).toBe(false);
  });

  const hostedEmpty = (notLive: boolean, over = {}) =>
    hostedCmsHeaderButton(
      select({ branch: ready(), publishableChangeCount: 0, ...over }),
      { notLive, t },
    );

  test("nothing listed and behind: Not live yet, with Publish", () => {
    const button = hostedEmpty(true);
    expect(button).toEqual({
      label: en["thread.publishPopover.publish"],
      action: "publish",
      variant: "brand",
      tooltip: en["thread.cmsActions.notLiveTooltip"],
      status: en["thread.cmsActions.notLive"],
      menu: [],
    });
    expect(en["thread.cmsActions.notLive"]).toBe("Not live yet");
    const view = renderHeaderButton(button);
    expect(
      view.getByRole("button", { name: en["thread.publishPopover.publish"] }),
    ).not.toBeDisabled();
  });

  test("live: Up to date, as before", () => {
    const button = hostedEmpty(false);
    expect(button.label).toBe(en["thread.headerActions.upToDate"]);
    expect(button.action).toBeUndefined();
    expect(button.status).toBeUndefined();
  });

  test("a busy state or listed changes win over Not live yet", () => {
    expect(hostedEmpty(true, { saving: true }).label).toBe(
      en["thread.headerActions.saving"],
    );
    expect(hostedEmpty(true, { publishing: true }).label).toBe(
      en["thread.cmsActions.publishing"],
    );
    expect(hostedEmpty(true, { loading: true }).status).toBeUndefined();
    const listed = hostedCmsHeaderButton(
      select({ branch: ready({ aheadOfBase: 1 }), publishableChangeCount: 1 }),
      { notLive: true, t },
    );
    expect(listed.label).toBe(en["thread.cmsActions.reviewAndPublish"]);
    expect(listed.status).toBeUndefined();
  });

  test("v7 and a v8 sandbox (not hosted) keep main's Up to date", () => {
    // Their header never wraps the selector's answer: it is main's.
    const upToDate = select({ branch: ready(), publishableChangeCount: 0 });
    expect(upToDate.label).toBe(en["thread.headerActions.upToDate"]);
    expect(upToDate.status).toBeUndefined();
    expect(hostedCmsHeaderButton(upToDate).label).toBe(
      en["thread.headerActions.upToDate"],
    );
  });
});
