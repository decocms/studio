import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
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
  type NamedRuleDetailProps,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  NamedRuleRenameSection,
  namedRuleUsesLabel,
  namedRuleViewBlocked,
  useNamedRuleRename,
} from "./named-rule-view";
import type { NamedRuleKind } from "./named-rules";
import type { NamedRuleChange } from "./use-apply-named-rule";

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
  // `broken` can't be read: not listed, but a rename can't move onto it.
  experiments: { __resolveType: "split-traffic", hero: 0, broken: "50" },
  campaigns: {
    __resolveType: "calendar",
    bf: { start: "2026-11-27T00:00:00-03:00" },
    broken: { start: 123 },
  },
};

function RenameHarness({
  kind,
  name,
  onSave,
  wholeUses = 0,
}: {
  kind: NamedRuleKind;
  name: string;
  onSave: NamedRuleDetailProps<{ name: string }>["onSave"];
  wholeUses?: number;
}) {
  const rename = useNamedRuleRename(kind, {
    row: { name },
    decofile,
    meta: meta as never,
    planStored: async (plan) => plan(decofile),
    onSave,
    onRenamed: () => {},
  });
  return (
    <NamedRuleRenameSection
      kind={kind}
      id="name"
      rename={rename}
      pending={false}
      wholeUses={wholeUses}
    />
  );
}

function renderRename(kind: NamedRuleKind, name: string, wholeUses = 0) {
  const onSave = mock(
    async (_change: NamedRuleChange | null, _title?: string) => true,
  );
  const view = render(
    <RenameHarness
      kind={kind}
      name={name}
      onSave={onSave}
      wholeUses={wholeUses}
    />,
  );
  const body = within(view.container);
  return { onSave, body };
}

describe("the views' shared rename", () => {
  for (const [kind, name, toast] of [
    ["experiments", "hero", "Test renamed to “launch”"],
    ["campaigns", "bf", "Campaign renamed to “launch”"],
  ] as const) {
    test(`${kind}: one change, with a toast that names the new name`, async () => {
      const { onSave, body } = renderRename(kind, name);
      typeInto(body.getByLabelText("Name"), "launch");
      await act(async () =>
        fireEvent.click(body.getByRole("button", { name: "Rename" })),
      );
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![1]).toBe(toast);
    });

    test(`${kind}: a name the block holds unreadable is taken`, () => {
      const { body } = renderRename(kind, name);
      typeInto(body.getByLabelText("Name"), "broken");
      expect(body.getByText("That name is already in use.")).toBeTruthy();
      expect(
        (body.getByRole("button", { name: "Rename" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  }

  test("both kinds say that sections reading every name keep the old one", () => {
    expect(
      renderRename("experiments", "hero", 1).body.getByText(
        /Sections that read every test in their own code/,
      ),
    ).toBeTruthy();
    expect(
      renderRename("campaigns", "bf", 1).body.getByText(
        /Sections that read every campaign in their own code/,
      ),
    ).toBeTruthy();
    expect(
      renderRename("experiments", "hero", 0).body.queryByText(
        /Sections that read every test/,
      ),
    ).toBeNull();
  });
});

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

  test("rows and badges speak per kind", () => {
    expect(namedRuleUsesLabel(translate, "experiments", 2)).toBe("Used by 2");
    expect(namedRuleUsesLabel(translate, "campaigns", 0)).toBe("Not used yet");
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
      <NamedRuleDraftNotes
        kind="campaigns"
        missing={[]}
        missingNames={0}
        removed={["xmas"]}
        onOpenUse={() => {}}
      />,
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
        "useNamedRuleRename(",
        "<NamedRuleRenameSection",
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
  }
});
