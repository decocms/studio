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
const infoCalls: string[] = [];
const infoSpy = spyOn(toast, "info").mockImplementation(((message: unknown) => {
  infoCalls.push(String(message));
  return 1;
}) as never);
afterAll(() => {
  toastSpy.mockRestore();
  infoSpy.mockRestore();
});
beforeEach(() => {
  toastCalls.length = 0;
  infoCalls.length = 0;
});

function setup(
  kind: NamedRuleKind,
  name: string,
  options: {
    loading?: boolean;
    /** What each read of the stored draft answers, in order (last repeats). */
    stored?: Array<Record<string, unknown> | null>;
  } = {},
) {
  const apply = mock(
    async (_change: NamedRuleChange): Promise<NamedRuleApplyOutcome> => ({
      ok: true,
    }),
  );
  const answers = options.stored ?? [decofile];
  let reads = 0;
  const reread = mock(async () => {
    const answer = answers[Math.min(reads, answers.length - 1)] ?? null;
    reads++;
    return answer;
  });
  const onDeleted = mock(() => {});
  const onUndo = mock((_change: NamedRuleChange) => {});
  const onOpenUse = mock((_row: NamedRuleUseRow) => {});
  render(
    <NamedRuleDeleteButton
      kind={kind}
      name={name}
      meta={meta}
      uses={options.loading ? null : uses}
      pending={false}
      apply={apply}
      reread={reread}
      onDeleted={onDeleted}
      onUndo={onUndo}
      onOpenUse={onOpenUse}
    />,
  );
  const body = within(document.body);
  const button = body.getByRole("button", {
    name: kind === "experiments" ? "Delete test" : "Delete campaign",
  });
  return { apply, reread, onDeleted, onUndo, onOpenUse, body, button };
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
    const { apply, onDeleted, body, button } = setup("experiments", "spare");
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
  });

  test("another tab started using the test: Delete reads the draft again and refuses", async () => {
    // The view's uses (read earlier) say "spare" is unused; the stored draft
    // now has a page using it.
    const now = {
      ...decofile,
      "pages-promo": page("Promo", "/promo", {
        __resolveType: "experiment",
        name: "spare",
      }),
    };
    const { apply, reread, onDeleted, body, button } = setup(
      "experiments",
      "spare",
      { stored: [now] },
    );
    await act(async () => fireEvent.click(button));
    expect(reread).toHaveBeenCalledTimes(1);
    const dialog = within(body.getByTestId("named-rule-in-use"));
    const items = dialog.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Promo");
    expect(apply).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  test("when the draft can't be read, nothing is deleted and one calm toast says so", async () => {
    const { apply, body, button } = setup("experiments", "spare", {
      stored: [null],
    });
    await act(async () => fireEvent.click(button));
    expect(apply).not.toHaveBeenCalled();
    expect(body.queryByTestId("named-rule-in-use")).toBeNull();
    expect(infoCalls).toEqual(["Can't save this right now"]);
  });

  test("Undo puts back only the deleted test, onto the block as it is now", async () => {
    // After the delete, another tab created "fresh".
    const later = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", hero: 50, fresh: 5 },
    };
    const { onUndo, button } = setup("experiments", "spare", {
      stored: [decofile, later],
    });
    await act(async () => fireEvent.click(button));
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).toHaveBeenCalledWith({
      writes: {
        experiments: {
          __resolveType: "split-traffic",
          hero: 50,
          fresh: 5,
          spare: 10,
        },
      },
    });
  });

  test("Undo does nothing when the test is back already", async () => {
    const { onUndo, button } = setup("experiments", "spare", {
      stored: [decofile, decofile],
    });
    await act(async () => fireEvent.click(button));
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).not.toHaveBeenCalled();
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
    const { apply, onUndo, button } = setup("campaigns", "spare", {
      stored: [
        decofile,
        {
          ...decofile,
          campaigns: {
            __resolveType: "date-windows",
            bf: decofile.campaigns.bf,
          },
        },
      ],
    });
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
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).toHaveBeenCalledWith({
      writes: { campaigns: decofile.campaigns },
    });
  });

  describe("saved rules", () => {
    const withRules = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", hero: 50, promo: 20 },
      // A saved rule a page uses, and one that nothing uses.
      "Promo%20visitors": { __resolveType: "experiment", name: "promo" },
      "Old%20promo": { __resolveType: "experiment", name: "promo" },
      "pages-promo": page("Promo", "/promo", {
        __resolveType: "Promo%20visitors",
      }),
    };
    const withoutOld = Object.fromEntries(
      Object.entries(withRules).filter(([key]) => key !== "Old%20promo"),
    );

    test("they are listed beside the pages, and never open as a section", async () => {
      const { body, button } = setup("experiments", "promo", {
        stored: [withRules],
      });
      await act(async () => fireEvent.click(button));
      const dialog = within(body.getByTestId("named-rule-in-use"));
      // The line fits saved rules too.
      expect(
        dialog.getByText(
          "These pages and saved rules use “promo”. Open each page and change or remove that variant, and remove any saved rule no page uses; then you can delete the test.",
        ),
      ).toBeTruthy();
      const items = dialog.getAllByRole("listitem");
      const text = items.map((item) => item.textContent ?? "");
      expect(
        text.some((t) => t.includes("Promo") && t.includes("/promo")),
      ).toBe(true);
      const used = items.find((item) =>
        item.textContent?.includes("Promo visitors"),
      )!;
      expect(used.textContent).toContain(
        "Saved rule · used by the pages listed",
      );
      expect(within(used).queryByRole("button")).toBeNull();
      const unused = items.find((item) =>
        item.textContent?.includes("Old promo"),
      )!;
      expect(unused.textContent).toContain("Saved rule · no page uses it");
      expect(within(unused).queryByText("Open")).toBeNull();
      expect(within(unused).getByText("Remove")).toBeTruthy();
      // Only the page opens.
      expect(dialog.getAllByText("Open")).toHaveLength(1);
    });

    test("a saved rule nothing uses is removed from the dialog, with an Undo", async () => {
      const { apply, onUndo, body, button } = setup("experiments", "promo", {
        stored: [withRules, withRules, withoutOld],
      });
      await act(async () => fireEvent.click(button));
      const dialog = within(body.getByTestId("named-rule-in-use"));
      await act(async () => fireEvent.click(dialog.getByText("Remove")));
      expect(apply).toHaveBeenCalledWith({
        writes: {},
        deletes: ["Old%20promo"],
      });
      expect(toastCalls.map((call) => call.message)).toEqual([
        "Saved rule “Old promo” removed from your draft",
      ]);
      // The dialog now lists what still keeps the test.
      const rows = within(body.getByTestId("named-rule-in-use"))
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
      expect(rows.some((row) => row.includes("Old promo"))).toBe(false);
      expect(rows.some((row) => row.includes("Promo visitors"))).toBe(true);
      toastCalls[0]!.action!.onClick();
      expect(onUndo).toHaveBeenCalledWith({
        writes: { "Old%20promo": withRules["Old%20promo"] },
      });
    });

    test("a saved rule that became used meanwhile isn't removed", async () => {
      const usedNow = {
        ...withRules,
        "pages-old": page("Old", "/old", { __resolveType: "Old%20promo" }),
      };
      const { apply, body, button } = setup("experiments", "promo", {
        stored: [withRules, usedNow],
      });
      await act(async () => fireEvent.click(button));
      const dialog = within(body.getByTestId("named-rule-in-use"));
      await act(async () => fireEvent.click(dialog.getByText("Remove")));
      expect(apply).not.toHaveBeenCalled();
      const rows = within(body.getByTestId("named-rule-in-use"))
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
      expect(rows.some((row) => row.includes("/old"))).toBe(true);
    });
  });

  test("the dialog speaks pt-br too", () => {
    expect(ptBR["sectionsEditor.namedRuleDelete.inUseTests"]).toBe(
      "Remova primeiro os testes destas páginas.",
    );
    expect(ptBR["sectionsEditor.namedRuleDelete.inUseCampaigns"]).toBe(
      "Remova primeiro a campanha destas páginas.",
    );
    expect(ptBR["sectionsEditor.namedRules.inUseHint"]).toBe(
      "Nada foi alterado. Antes, ajuste as páginas que ainda usam isto; “Usado em” mostra quais são.",
    );
    for (const key of [
      "sectionsEditor.namedRuleDelete.inUseTestsHint",
      "sectionsEditor.namedRuleDelete.inUseCampaignsHint",
      "sectionsEditor.namedRuleDelete.inUseTestsHintRules",
      "sectionsEditor.namedRuleDelete.inUseCampaignsHintRules",
      "sectionsEditor.namedRuleDelete.ruleRemoved",
      "sectionsEditor.namedRuleDelete.close",
      "sectionsEditor.namedRuleUses.savedRule",
      "sectionsEditor.namedRuleUses.savedRuleUsed",
      "sectionsEditor.namedRuleUses.savedRuleUnused",
      "sectionsEditor.namedRuleUses.removeRule",
      "sectionsEditor.namedRules.inUse",
      "sectionsEditor.namedRules.inUseHint",
    ] as const) {
      expect(ptBR[key]).toBeTruthy();
      expect(ptBR[key]).not.toBe(en[key]);
    }
  });
});
