import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { NamedRuleDeleteButton } from "./named-rule-delete";
import { type NamedRuleUseRow, namedRuleUses } from "./named-rule-uses";
import type { NamedRuleKind } from "./named-rules";
import type {
  NamedRuleApplyOutcome,
  NamedRuleChange,
} from "./use-apply-named-rule";

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
const meta = {
  manifest: {
    blocks: {
      matchers: { always: builtIn, date: builtIn, experiment: builtIn },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, "date-windows": builtIn },
      pages: { page: builtIn },
    },
  },
  schema: {},
};

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const page = (name: string, path: string, rule: unknown) => ({
  __resolveType: "page",
  name,
  path,
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule: { __resolveType: "always" }, value: lazy([]) },
      { rule, value: lazy([]) },
    ],
  },
});

const decofile = {
  experiments: { __resolveType: "split-traffic", hero: 50, spare: 10 },
  campaigns: {
    __resolveType: "date-windows",
    bf: { start: "2026-11-27T00:00:00-03:00" },
    spare: { end: "2026-01-01T00:00:00Z" },
  },
  "pages-home": page("Home", "/", {
    __resolveType: "experiment",
    name: "hero",
  }),
  "pages-sale": page("Sale", "/sale", {
    __resolveType: "date",
    campaign: "bf",
  }),
  // Reads every test and campaign in its own code: never blocks a delete.
  Banner: {
    __resolveType: "site/sections/Banner.tsx",
    tests: { __resolveType: "experiments" },
    dates: { __resolveType: "campaigns" },
  },
};

const uses = namedRuleUses({
  decofile,
  meta,
  changeCount: 0,
  sides: undefined,
});

const toastCalls: Array<{
  message: string;
  action?: { label: string; onClick: () => void };
}> = [];
const toastSpy = spyOn(toast, "success").mockImplementation(((
  message: unknown,
  options?: { action?: { label: string; onClick: () => void } },
) => {
  toastCalls.push({ message: String(message), action: options?.action });
  return 1;
}) as never);
afterAll(() => toastSpy.mockRestore());
beforeEach(() => {
  toastCalls.length = 0;
});

function setup(
  kind: NamedRuleKind,
  name: string,
  options: { loading?: boolean } = {},
) {
  const apply = mock(
    async (_change: NamedRuleChange): Promise<NamedRuleApplyOutcome> => ({
      ok: true,
    }),
  );
  const onDeleted = mock(() => {});
  const onUndo = mock((_change: NamedRuleChange) => {});
  const onOpenUse = mock((_row: NamedRuleUseRow) => {});
  render(
    <NamedRuleDeleteButton
      kind={kind}
      name={name}
      decofile={decofile}
      meta={meta}
      uses={options.loading ? null : uses}
      pending={false}
      apply={apply}
      onDeleted={onDeleted}
      onUndo={onUndo}
      onOpenUse={onOpenUse}
    />,
  );
  const body = within(document.body);
  const button = body.getByRole("button", {
    name: kind === "experiments" ? "Delete test" : "Delete campaign",
  });
  return { apply, onDeleted, onUndo, onOpenUse, body, button };
}

describe("NamedRuleDeleteButton", () => {
  test("a test that pages use isn't deleted: the dialog lists the pages", async () => {
    const { apply, onDeleted, body, button } = setup("experiments", "hero");
    await act(async () => fireEvent.click(button));
    const dialog = within(body.getByTestId("named-rule-in-use"));
    expect(
      dialog.getByText("Please remove the tests on these pages first."),
    ).toBeTruthy();
    const items = dialog.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Home");
    expect(items[0]!.textContent).toContain("/ · Variant 2");
    // The section that reads every test isn't listed.
    expect(dialog.queryByText("Banner")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(toastCalls).toEqual([]);
    // One close button, no corner X.
    const buttons = dialog
      .getAllByRole("button")
      .filter(
        (b) =>
          b.textContent?.trim() === "Close" && !b.classList.contains("hidden"),
      );
    expect(buttons).toHaveLength(1);
    await act(async () => fireEvent.click(buttons[0]!));
    expect(body.queryByTestId("named-rule-in-use")).toBeNull();
  });

  test("a page in the dialog opens in the site editor", async () => {
    const { onOpenUse, body, button } = setup("experiments", "hero");
    await act(async () => fireEvent.click(button));
    const dialog = within(body.getByTestId("named-rule-in-use"));
    await act(async () => fireEvent.click(dialog.getByText("Open")));
    expect(onOpenUse).toHaveBeenCalledTimes(1);
    expect(onOpenUse.mock.calls[0]![0]).toMatchObject({
      blockKey: "pages-home",
      blockKind: "page",
      variant: 2,
    });
    expect(body.queryByTestId("named-rule-in-use")).toBeNull();
  });

  test("an unused test is deleted from the draft, with an Undo", async () => {
    const { apply, onDeleted, onUndo, body, button } = setup(
      "experiments",
      "spare",
    );
    await act(async () => fireEvent.click(button));
    expect(body.queryByTestId("named-rule-in-use")).toBeNull();
    expect(apply).toHaveBeenCalledWith({
      writes: { experiments: { __resolveType: "split-traffic", hero: 50 } },
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(toastCalls.map((call) => call.message)).toEqual([
      "Test “spare” deleted from your draft",
    ]);
    expect(toastCalls[0]!.action?.label).toBe("Undo");
    toastCalls[0]!.action!.onClick();
    expect(onUndo).toHaveBeenCalledWith({
      writes: {
        experiments: { __resolveType: "split-traffic", hero: 50, spare: 10 },
      },
    });
  });

  test("while the uses load, Delete waits and says why", () => {
    const { apply, body, button } = setup("experiments", "spare", {
      loading: true,
    });
    expect(button).toBeDisabled();
    expect(body.getByTestId("named-rule-delete-loading").textContent).toBe(
      "Checking where it's used…",
    );
    fireEvent.click(button);
    expect(apply).not.toHaveBeenCalled();
  });

  test("a campaign that pages use isn't deleted: the dialog lists the pages", async () => {
    const { apply, onOpenUse, body, button } = setup("campaigns", "bf");
    await act(async () => fireEvent.click(button));
    const dialog = within(body.getByTestId("named-rule-in-use"));
    expect(
      dialog.getByText("Please remove the campaign from these pages first."),
    ).toBeTruthy();
    const items = dialog.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Sale");
    expect(items[0]!.textContent).toContain("/sale · Variant 2");
    expect(apply).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(dialog.getByText("Open")));
    expect(onOpenUse.mock.calls[0]![0]).toMatchObject({
      blockKey: "pages-sale",
      blockKind: "page",
    });
  });

  test("an unused campaign is deleted, with an Undo that brings its window back", async () => {
    const { apply, onUndo, button } = setup("campaigns", "spare");
    await act(async () => fireEvent.click(button));
    expect(apply).toHaveBeenCalledWith({
      writes: {
        campaigns: {
          __resolveType: "date-windows",
          bf: { start: "2026-11-27T00:00:00-03:00" },
        },
      },
    });
    expect(toastCalls.map((call) => call.message)).toEqual([
      "Campaign “spare” deleted from your draft",
    ]);
    toastCalls[0]!.action!.onClick();
    expect(onUndo).toHaveBeenCalledWith({
      writes: { campaigns: decofile.campaigns },
    });
  });

  test("the dialog speaks pt-br too", () => {
    expect(ptBR["sectionsEditor.namedRuleDelete.inUseTests"]).toBe(
      "Remova primeiro os testes destas páginas.",
    );
    expect(ptBR["sectionsEditor.namedRuleDelete.inUseCampaigns"]).toBe(
      "Remova primeiro a campanha destas páginas.",
    );
    for (const key of [
      "sectionsEditor.namedRuleDelete.inUseTestsHint",
      "sectionsEditor.namedRuleDelete.inUseCampaignsHint",
      "sectionsEditor.namedRuleDelete.close",
      "sectionsEditor.namedRules.inUse",
      "sectionsEditor.namedRules.inUseHint",
    ] as const) {
      expect(ptBR[key]).toBeTruthy();
      expect(ptBR[key]).not.toBe(en[key]);
    }
  });
});
