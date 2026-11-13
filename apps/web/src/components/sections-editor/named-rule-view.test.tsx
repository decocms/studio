import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { translate } from "@/i18n/use-t.ts";
import { nameProblemMessage } from "./named-rule-step";
import {
  NamedRuleCreateDialog,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  namedRuleViewBlocked,
} from "./named-rule-view";

/**
 * Types into a controlled field. happy-dom doesn't deliver input events to
 * React's change handling here, so this calls the field's own `onChange`
 * (as matcher-picker-named.test.tsx does).
 */
function typeInto(element: HTMLElement, value: string) {
  const propsKey = Object.keys(element).find((k) =>
    k.startsWith("__reactProps$"),
  );
  const props = (element as unknown as Record<string, { onChange?: unknown }>)[
    propsKey ?? ""
  ];
  const onChange = props?.onChange as
    | ((event: { target: { value: string } }) => void)
    | undefined;
  if (!onChange) throw new Error("not a controlled field");
  act(() => onChange({ target: { value } }));
}

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
const meta = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      matchers: { always: builtIn, campaign: builtIn, experiment: builtIn },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
      pages: { page: builtIn },
    },
  },
  schema: {},
};

const decofile = {
  // `broken` can't be read: not listed.
  experiments: { __resolveType: "split-traffic", hero: 0, broken: "50" },
  campaigns: {
    __resolveType: "calendar",
    bf: { start: "2026-11-27T00:00:00-03:00" },
    broken: { start: 123 },
  },
};

describe("the views' shared pieces", () => {
  test("blocked: the site's schema first, then a clashing block", () => {
    expect(namedRuleViewBlocked(decofile, null, "experiments")).toBe("missing");
    expect(namedRuleViewBlocked(decofile, meta as never, "experiments")).toBe(
      null,
    );
    expect(
      namedRuleViewBlocked(
        { campaigns: { __resolveType: "site/loaders/x.ts" } },
        meta as never,
        "campaigns",
      ),
    ).toBe("conflict");
  });

  test("a name's problem in words; the picker adds where to pick a taken one", () => {
    const t = translate;
    expect(nameProblemMessage(t, "empty")).toBe("Give it a name.");
    expect(nameProblemMessage(t, "reserved")).toBe(
      "Names can't start with two underscores.",
    );
    expect(nameProblemMessage(t, "taken")).toBe("That name is already in use.");
    expect(nameProblemMessage(t, "taken", { pickFromList: true })).toBe(
      "That name is already in use. Pick it from the list instead.",
    );
  });

  test("the create dialog has no list to pick a taken name from", () => {
    render(
      <NamedRuleCreateDialog
        kind="experiments"
        open
        onOpenChange={() => {}}
        existingNames={["hero"]}
        pending={false}
        onCreate={() => {}}
      />,
    );
    const body = within(document.body);
    typeInto(body.getByLabelText("Name"), "hero");
    fireEvent.click(body.getByRole("button", { name: "Create" }));
    expect(body.getByText("That name is already in use.")).toBeTruthy();
  });

  test("badges speak per kind", () => {
    const badge = render(
      <>
        <NamedRuleEntryBadge kind="campaigns" state="changed" />
        <NamedRuleEntryBadge kind="campaigns" state="changed" changed={false} />
      </>,
    );
    expect(
      within(badge.container).getAllByText("Changed in your draft"),
    ).toHaveLength(1);
  });

  test("the names removed in the draft are listed, with the kind's hint", () => {
    const view = render(
      <NamedRuleDraftNotes kind="campaigns" removed={["xmas"]} />,
    );
    const body = within(view.container);
    expect(body.getByText("Removed in your draft")).toBeTruthy();
    expect(
      body.getByText(/These campaigns stop when you publish/),
    ).toBeTruthy();
    expect(body.getByText("xmas")).toBeTruthy();
  });
});

describe("Experiments and Calendar share one view shell", () => {
  const src = join(import.meta.dir, "../..");
  for (const file of [
    "layouts/main-panel-tabs/experiments-block-tab.tsx",
    "components/sandbox/content/campaigns/campaigns-view.tsx",
  ]) {
    test(`${file} builds on named-rule-view`, () => {
      const source = readFileSync(join(src, file), "utf8");
      for (const shared of [
        "useNamedRuleView(",
        "<NamedRuleCreateDialog",
        "<NamedRuleDraftNotes",
        "<NamedRuleDetailDelete",
      ]) {
        expect(source).toContain(shared);
      }
      for (const copied of [
        "planNamedRuleCreate",
        "newNameProblem",
        "useApplyNamedRule(",
        "SITE_EDITOR_SAVE_TOAST",
      ]) {
        expect(source).not.toContain(copied);
      }
    });

    test(`${file} says nowhere where a name is used, and renames none`, () => {
      const source = readFileSync(join(src, file), "utf8");
      for (const gone of [
        "NamedRuleUsedBy",
        "namedRuleUsesLabel",
        "namedRuleDetailUses",
        "useNamedRuleRename",
        "NamedRuleRenameSection",
        "planStored",
        "onOpenUse",
      ]) {
        expect(source).not.toContain(gone);
      }
    });
  }
});
