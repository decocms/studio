import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import { MatcherPicker, type MatcherEntry } from "./matcher-picker";
import {
  type NamedRulePick,
  type NamedRulePickerKind,
  namedRuleRowState,
} from "./named-rule-picker";
import { namedRuleOf } from "./named-rules";
import { VariantRuleEditor } from "./variant-rule-editor";
import { ptBR } from "@/i18n/pt-br/index.ts";
import {
  NamedRuleCreateForm,
  NamedRuleRow,
  NamedRuleViewsProvider,
} from "./named-rule-step";

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );

beforeAll(() => {
  // cmdk measures and scrolls its list; happy-dom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const MATCHERS: MatcherEntry[] = [
  { resolveType: "never", title: "Never", iconName: "EyeOff" },
  { resolveType: "experiment", title: "A/B test", iconName: "flask" },
  { resolveType: "date", title: "Date", iconName: "calendar-event" },
  { resolveType: "device", title: "Device", iconName: "Monitor01" },
];

const KINDS: NamedRulePickerKind[] = [
  {
    kind: "experiments",
    state: "saved",
    entries: [{ name: "hero-test", summary: "50% of visitors" }],
  },
  { kind: "campaigns", state: "absent", entries: [] },
];

function openPicker(named?: Parameters<typeof MatcherPicker>[0]["named"]) {
  const onSelect = mock((_rt: string) => {});
  render(
    <MatcherPicker
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
      onSelect={onSelect}
      named={named}
    />,
  );
  fireEvent.click(
    within(document.body).getByRole("button", { name: /Always/ }),
  );
  return { onSelect, dialog: within(document.body).getByRole("dialog") };
}

const optionTexts = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("option")
    .map((o) => o.textContent ?? "");

describe("the rule picker on a v7 site", () => {
  test("lists the matchers as before, with no named items", () => {
    const { dialog } = openPicker();
    const texts = optionTexts(dialog);
    expect(texts.some((t) => t.startsWith("A/B test"))).toBe(true);
    expect(texts.some((t) => t.includes("Show this variant"))).toBe(false);
  });
});

describe("the rule picker on a v8 site", () => {
  test("offers A/B test and Date in place of the raw rules", () => {
    const { dialog } = openPicker({
      kinds: KINDS,
      selected: null,
      onPick: () => {},
    });
    const texts = optionTexts(dialog);
    expect(texts).toContainEqual(
      expect.stringContaining("Show this variant to a share of visitors"),
    );
    expect(texts).toContainEqual(
      expect.stringContaining("Show this variant while a campaign is running"),
    );
    // The raw `experiment` and `date` rules aren't listed a second time.
    expect(texts.filter((t) => t.startsWith("A/B test"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("Date"))).toHaveLength(1);
    expect(texts.some((t) => t.startsWith("Device"))).toBe(true);
  });

  test("picks an existing test by name", async () => {
    const onPick = mock((_pick: NamedRulePick) => {});
    const { dialog } = openPicker({ kinds: KINDS, selected: null, onPick });
    fireEvent.click(within(dialog).getByText("A/B test"));
    fireEvent.click(await within(dialog).findByText("hero-test"));
    await Promise.resolve();
    expect(onPick).toHaveBeenCalledWith({
      kind: "experiments",
      name: "hero-test",
    });
  });

  test("an empty list says how to start", () => {
    const { dialog } = openPicker({
      kinds: KINDS,
      selected: null,
      onPick: () => {},
    });
    fireEvent.click(within(dialog).getByText("Date"));
    expect(
      within(dialog).getByText("No campaigns yet. Type a name to create one."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText(
        "Search your campaigns or type a new name…",
      ),
    ).toBeInTheDocument();
  });

  test("explains a block of that name that holds something else", () => {
    const { dialog } = openPicker({
      kinds: [{ kind: "experiments", state: "conflict", entries: [] }],
      selected: null,
      onPick: () => {},
    });
    fireEvent.click(within(dialog).getByText("A/B test"));
    expect(
      within(dialog).getByText(/isn't a list of A\/B tests/),
    ).toBeInTheDocument();
  });
});

describe("the locked row", () => {
  test("shows the name and leads to Experiments", () => {
    const open = mock((_kind: string) => {});
    render(
      <NamedRuleViewsProvider value={{ open }}>
        <NamedRuleRow
          kind="experiments"
          name="hero-test"
          summary="50% of visitors"
          missing={false}
        />
      </NamedRuleViewsProvider>,
    );
    expect(within(document.body).getByText("hero-test")).toBeInTheDocument();
    expect(within(document.body).queryByRole("textbox")).toBeNull();
    fireEvent.click(
      within(document.body).getByRole("button", { name: /Open Experiments/ }),
    );
    expect(open).toHaveBeenCalledWith("experiments");
  });

  test("says a missing campaign no longer exists, and shows no link without a way there", () => {
    render(<NamedRuleRow kind="campaigns" name="gone" summary="" missing />);
    expect(
      within(document.body).getByTestId("named-rule-missing").textContent,
    ).toBe(
      "This campaign no longer exists. Pick another or remove this variant.",
    );
    expect(within(document.body).queryByRole("button")).toBeNull();
  });

  test("a deleted test: the variant says so, with the picker one click away", () => {
    const rule = { __resolveType: "experiment", name: "gone" };
    render(
      <VariantRuleEditor
        currentRt="experiment"
        currentLabel="A/B test"
        matchers={MATCHERS}
        globals={[]}
        onSelect={() => {}}
        onSelectGlobal={() => {}}
        schema={null}
        formValue={null}
        onChange={() => {}}
        formKey="rule"
        formWrapperClassName=""
        named={{ kinds: KINDS, selected: namedRuleOf(rule), onPick: () => {} }}
        namedRow={namedRuleRowState(rule, KINDS)}
      />,
    );
    const body = within(document.body);
    expect(body.getByTestId("named-rule-missing").textContent).toBe(
      "This test no longer exists. Pick another or remove this variant.",
    );
    fireEvent.click(body.getByRole("button", { name: /A\/B test/ }));
    expect(
      within(body.getByRole("dialog")).queryAllByRole("option").length,
    ).toBeGreaterThan(0);
  });

  test("a deleted test inside a combined rule: the variant says so under its form", () => {
    const rule = {
      __resolveType: "multi",
      op: "and",
      matchers: [{ __resolveType: "experiment", name: "gone" }],
    };
    render(
      <VariantRuleEditor
        currentRt="multi"
        currentLabel="Multi"
        matchers={MATCHERS}
        globals={[]}
        onSelect={() => {}}
        onSelectGlobal={() => {}}
        schema={null}
        formValue={null}
        onChange={() => {}}
        formKey="rule"
        formWrapperClassName=""
        named={{ kinds: KINDS, selected: namedRuleOf(rule), onPick: () => {} }}
        namedRow={namedRuleRowState(rule, KINDS)}
        rule={rule}
        decofile={{}}
      />,
    );
    expect(
      within(document.body).getByTestId("named-rule-missing-within")
        .textContent,
    ).toBe(
      "This rule uses a test that no longer exists. Change the rule or remove this variant.",
    );
  });

  test("says it in pt-br too", () => {
    expect(ptBR["sectionsEditor.namedRulePicker.missingTest"]).toBe(
      "Este teste não existe mais. Escolha outro ou remova esta variante.",
    );
    expect(ptBR["sectionsEditor.namedRulePicker.missingCampaign"]).toBe(
      "Esta campanha não existe mais. Escolha outra ou remova esta variante.",
    );
    expect(ptBR["sectionsEditor.namedRulePicker.missingTestWithin"]).toBe(
      "Esta regra usa um teste que não existe mais. Altere a regra ou remova esta variante.",
    );
  });
});

describe("creating a name", () => {
  test("a test starts at 50% of visitors", () => {
    const onSubmit = mock((_pick: NamedRulePick) => {});
    render(
      <NamedRuleCreateForm
        kind="experiments"
        initialName="cta-test"
        existingNames={["hero-test"]}
        onBack={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const body = within(document.body);
    expect(
      (
        body.getByLabelText(
          "Visitors who see this variant (%)",
        ) as HTMLInputElement
      ).value,
    ).toBe("50");
    fireEvent.click(body.getByRole("button", { name: "Create and use" }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "experiments",
      name: "cta-test",
      create: { share: 50 },
    });
  });

  test("guides instead of saving a name that is taken", () => {
    const onSubmit = mock((_pick: NamedRulePick) => {});
    render(
      <NamedRuleCreateForm
        kind="experiments"
        initialName="hero-test"
        existingNames={["hero-test"]}
        onBack={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const body = within(document.body);
    fireEvent.click(body.getByRole("button", { name: "Create and use" }));
    expect(
      body.getByText(
        "That name is already in use. Pick it from the list instead.",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a campaign starts with an inline date rule's dates", () => {
    const onSubmit = mock((_pick: NamedRulePick) => {});
    render(
      <NamedRuleCreateForm
        kind="campaigns"
        initialName="Black Friday"
        existingNames={[]}
        prefill={{ start: "2026-11-27T00:00:00-03:00" }}
        onBack={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const body = within(document.body);
    expect((body.getByLabelText("Starts") as HTMLInputElement).value).not.toBe(
      "",
    );
    expect((body.getByLabelText("Ends") as HTMLInputElement).value).toBe("");
    fireEvent.click(body.getByRole("button", { name: "Create and use" }));
    const pick = onSubmit.mock.calls[0]![0] as Extract<
      NamedRulePick,
      { kind: "campaigns" }
    >;
    expect(pick.name).toBe("Black Friday");
    // The same moment, in the editor's offset; no end, so it stays open.
    expect(Object.keys(pick.create!.window)).toEqual(["start"]);
    expect(new Date(pick.create!.window.start!).getTime()).toBe(
      new Date("2026-11-27T00:00:00-03:00").getTime(),
    );
  });
});
