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
import { ptBR } from "@/i18n/pt-br/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  cmsHeaderButtonLabels,
  hostedCmsHeaderButton,
  selectCmsHeaderButton,
  type SelectCmsHeaderButtonInput,
} from "./cms-panel-state";
import type { PrSummary } from "./use-pr-data";

/**
 * The Fast Preview header button must keep one width across its states: a
 * "Review & Publish" → "Saving…" swap that resizes it shifts the whole header
 * on the x axis. Width is reserved by rendering every label in one grid cell,
 * so these tests assert the DOM shape that guarantees it (happy-dom has no
 * layout to measure): all labels present, exactly one exposed, and that one
 * being the button's accessible name.
 */

function tFor(dictionary: Record<TranslationKey, string>): TFunction {
  return (key: TranslationKey, vars?: InterpolationVars) =>
    interpolate(dictionary[key], vars);
}

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

function select(t: TFunction, over: Partial<SelectCmsHeaderButtonInput>) {
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

describe.each([
  ["en", tFor(en)],
  ["pt-BR", tFor(ptBR)],
] as const)("CMS header button width (%s)", (_locale, t) => {
  const labels = cmsHeaderButtonLabels(t);

  test("the reserved label set covers every state the selector produces", () => {
    for (const over of Object.values(STATES)) {
      expect(labels).toContain(select(t, over).label);
    }
  });

  test.each(Object.keys(STATES))(
    "%s: renders every label, exposes only the active one",
    (state) => {
      const button = select(t, STATES[state] ?? {});
      const view = render(
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
            stableLabels={labels}
          />
        </TooltipProvider>,
      );

      // Every label is in the DOM, stacked in the one grid cell.
      const reserved = document.querySelectorAll(
        '[data-slot="split-button-label-reserve"]',
      );
      const active = document.querySelectorAll(
        '[data-slot="split-button-label"]',
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.textContent).toBe(button.label);
      expect(reserved).toHaveLength(labels.length - 1);
      const rendered = [...reserved, ...active].map((n) => n.textContent);
      expect(rendered.toSorted()).toEqual([...labels].toSorted());

      // Only the active one is visible / exposed to assistive tech.
      for (const node of reserved) {
        expect(node).toHaveAttribute("aria-hidden", "true");
        expect(node).toHaveClass("invisible");
      }
      expect(active[0]).not.toHaveAttribute("aria-hidden");
      expect(active[0]).not.toHaveClass("invisible");

      // The primary's accessible name is exactly the active label.
      expect(
        view.getByRole("button", { name: button.label }),
      ).toBeInTheDocument();
      for (const other of labels.filter((l) => l !== button.label)) {
        expect(view.queryByRole("button", { name: other })).toBeNull();
      }

      // The chevron half keeps its place even when there is no menu.
      expect(
        view.getByRole("button", { name: "More actions" }),
      ).toBeInTheDocument();
    },
  );
});

/** Renders the header's split button the way `CmsHeaderActions` does. */
function renderHeaderButton(
  button: ReturnType<typeof selectCmsHeaderButton>,
  labels: string[],
  hosted: boolean,
) {
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
        stableLabels={labels}
        reserveMenu={!hosted}
      />
    </TooltipProvider>,
  );
}

/**
 * A hosted v8 draft has no secondary actions (no pull request, nothing to
 * sync), so its header button is a plain one: no chevron, in any state, while
 * a v7 (branch) project keeps its split button.
 */
describe("hosted v8 header button", () => {
  const t = tFor(en);
  const labels = cmsHeaderButtonLabels(t);

  test.each(Object.keys(STATES))("%s: no menu trigger", (state) => {
    const button = hostedCmsHeaderButton(select(t, STATES[state] ?? {}));
    expect(button.menu).toEqual([]);
    const view = renderHeaderButton(button, labels, true);
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull();
    // Still the stable-width primary, named by its active label.
    expect(
      document.querySelectorAll('[data-slot="split-button-label-reserve"]'),
    ).toHaveLength(labels.length - 1);
    expect(
      view.getByRole("button", { name: button.label }),
    ).toBeInTheDocument();
  });

  test("with unpublished work, Review & Publish has no chevron", () => {
    const selected = select(t, STATES.reviewAndPublish ?? {});
    // The item a hosted draft used to filter out by hand.
    expect(selected.menu.map((item) => item.key)).toEqual(["request-approval"]);
    const view = renderHeaderButton(
      hostedCmsHeaderButton(selected),
      labels,
      true,
    );
    expect(
      view.getByRole("button", {
        name: en["thread.cmsActions.reviewAndPublish"],
      }),
    ).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  test("v7 keeps the split button and its menu", () => {
    const selected = select(t, STATES.reviewAndPublish ?? {});
    const view = renderHeaderButton(selected, labels, false);
    const trigger = view.getByRole("button", { name: "More actions" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
    // Empty-menu states keep the (disabled) chevron's place, as before.
    view.unmount();
    const upToDate = renderHeaderButton(select(t, {}), labels, false);
    expect(
      upToDate.getByRole("button", { name: "More actions" }),
    ).toBeDisabled();
  });
});

test("a label shared by two states renders once, with a single accessible name", () => {
  const view = render(
    <TooltipProvider>
      <SplitButton
        size="sm"
        label="Saving…"
        loading
        menuAriaLabel="More actions"
        stableLabels={["Saving…", "Review & Publish", "Saving…"]}
      />
    </TooltipProvider>,
  );
  expect(
    document.querySelectorAll('[data-slot="split-button-label"]'),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll('[data-slot="split-button-label-reserve"]'),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
});
