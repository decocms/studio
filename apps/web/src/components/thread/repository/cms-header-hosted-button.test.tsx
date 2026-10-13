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
