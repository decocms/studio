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
      matchers: { always: builtIn, campaign: builtIn, experiment: builtIn },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
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
    __resolveType: "calendar",
    bf: { start: "2026-11-27T00:00:00-03:00" },
    spare: { end: "2026-01-01T00:00:00Z" },
  },
  "pages-home": page("Home", "/", {
    __resolveType: "experiment",
    name: "hero",
  }),
  "pages-sale": page("Sale", "/sale", {
    __resolveType: "campaign",
    name: "bf",
  }),
  // Reads every test and campaign in its own code: not counted as a use.
  Banner: {
    __resolveType: "site/sections/Banner.tsx",
    tests: { __resolveType: "experiments" },
    dates: { __resolveType: "campaigns" },
  },
};

const toastCalls: Array<{
  message: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}> = [];
const toastSpy = spyOn(toast, "success").mockImplementation(((
  message: unknown,
  options?: {
    description?: string;
    action?: { label: string; onClick: () => void };
  },
) => {
  toastCalls.push({
    message: String(message),
    description: options?.description,
    action: options?.action,
  });
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
  render(
    <NamedRuleDeleteButton
      kind={kind}
      name={name}
      meta={meta}
      pending={false}
      apply={apply}
      reread={reread}
      onDeleted={onDeleted}
      onUndo={onUndo}
    />,
  );
  const body = within(document.body);
  const button = body.getByRole("button", {
    name: kind === "experiments" ? "Delete test" : "Delete campaign",
  });
  return { apply, reread, onDeleted, onUndo, body, button };
}

describe("NamedRuleDeleteButton", () => {
  test("a test that pages use is deleted, with an Undo and how many pages and sections still use it", async () => {
    const { apply, onDeleted, onUndo, body, button } = setup(
      "experiments",
      "hero",
      {
        stored: [
          decofile,
          {
            ...decofile,
            experiments: { __resolveType: "split-traffic", spare: 10 },
          },
        ],
      },
    );
    await act(async () => fireEvent.click(button));
    // Never a dialog: it goes through.
    expect(body.queryByRole("dialog")).toBeNull();
    expect(apply).toHaveBeenCalledWith({
      writes: { experiments: { __resolveType: "split-traffic", spare: 10 } },
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]!.message).toBe("Test “hero” deleted from your draft");
    expect(toastCalls[0]!.description).toBe(
      "1 page still uses it. Undo brings it back.",
    );
    expect(toastCalls[0]!.action?.label).toBe("Undo");
    // Undo puts back only "hero".
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).toHaveBeenCalledWith({
      writes: {
        experiments: { __resolveType: "split-traffic", spare: 10, hero: 50 },
      },
    });
  });

  test("the toast counts every page that still uses it", async () => {
    const now = {
      ...decofile,
      "pages-promo": page("Promo", "/promo", {
        __resolveType: "experiment",
        name: "hero",
      }),
    };
    const { button } = setup("experiments", "hero", { stored: [now] });
    await act(async () => fireEvent.click(button));
    expect(toastCalls[0]!.description).toBe(
      "2 pages still use it. Undo brings it back.",
    );
  });

  test("the toast counts pages and sections apart, never a section as a page", async () => {
    const now = {
      ...decofile,
      "pages-promo": page("Promo", "/promo", {
        __resolveType: "experiment",
        name: "hero",
      }),
      Hero: {
        __resolveType: "site/sections/Hero.tsx",
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "experiment", name: "hero" }, value: "B" },
          ],
        },
      },
    };
    const { button } = setup("experiments", "hero", { stored: [now] });
    await act(async () => fireEvent.click(button));
    expect(toastCalls[0]!.description).toBe(
      "2 pages and 1 section still use it. Undo brings it back.",
    );
  });

  test("an unused test is deleted from the draft, with the usual hint", async () => {
    const { apply, onDeleted, button } = setup("experiments", "spare");
    await act(async () => fireEvent.click(button));
    expect(apply).toHaveBeenCalledWith({
      writes: { experiments: { __resolveType: "split-traffic", hero: 50 } },
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(toastCalls.map((call) => call.message)).toEqual([
      "Test “spare” deleted from your draft",
    ]);
    expect(toastCalls[0]!.description).toBe(
      "It leaves the site when you publish. Undo brings it back.",
    );
  });

  test("Delete plans from the draft as stored now", async () => {
    // Another tab created "fresh" after the view read.
    const now = {
      ...decofile,
      experiments: {
        __resolveType: "split-traffic",
        hero: 50,
        spare: 10,
        fresh: 5,
      },
    };
    const { apply, reread, button } = setup("experiments", "spare", {
      stored: [now],
    });
    await act(async () => fireEvent.click(button));
    expect(reread).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      writes: {
        experiments: { __resolveType: "split-traffic", hero: 50, fresh: 5 },
      },
    });
  });

  test("when the draft can't be read, nothing is deleted and one calm toast says so", async () => {
    const { apply, button } = setup("experiments", "spare", {
      stored: [null],
    });
    await act(async () => fireEvent.click(button));
    expect(apply).not.toHaveBeenCalled();
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

  test("Undo writes nothing when the test is back already, and says so", async () => {
    const { onUndo, button } = setup("experiments", "spare", {
      stored: [decofile, decofile],
    });
    await act(async () => fireEvent.click(button));
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).not.toHaveBeenCalled();
    expect(infoCalls).toEqual(["It's back already"]);
  });

  test("Undo says the block changed when it holds something else now", async () => {
    const { onUndo, button } = setup("experiments", "spare", {
      stored: [
        decofile,
        { ...decofile, experiments: { __resolveType: "site/loaders/x.ts" } },
      ],
    });
    await act(async () => fireEvent.click(button));
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).not.toHaveBeenCalled();
    expect(infoCalls).toEqual(["This changed while you were editing"]);
  });

  test("a campaign that pages use is deleted, with an Undo that brings its window back", async () => {
    const { apply, onUndo, button } = setup("campaigns", "bf", {
      stored: [
        decofile,
        {
          ...decofile,
          campaigns: {
            __resolveType: "calendar",
            spare: decofile.campaigns.spare,
          },
        },
      ],
    });
    await act(async () => fireEvent.click(button));
    expect(apply).toHaveBeenCalledWith({
      writes: {
        campaigns: {
          __resolveType: "calendar",
          spare: { end: "2026-01-01T00:00:00Z" },
        },
      },
    });
    expect(toastCalls[0]!.message).toBe(
      "Campaign “bf” deleted from your draft",
    );
    expect(toastCalls[0]!.description).toBe(
      "1 page still uses it. Undo brings it back.",
    );
    await act(async () => toastCalls[0]!.action!.onClick());
    expect(onUndo).toHaveBeenCalledWith({
      writes: {
        campaigns: {
          __resolveType: "calendar",
          spare: decofile.campaigns.spare,
          bf: decofile.campaigns.bf,
        },
      },
    });
  });

  test("the toast speaks pt-br too", () => {
    expect(ptBR["sectionsEditor.namedRuleDelete.stillUsedOne"]).toBe(
      "{places} ainda usa. Desfazer traz de volta.",
    );
    expect(ptBR["sectionsEditor.namedRuleDelete.stillUsed"]).toBe(
      "{places} ainda usam. Desfazer traz de volta.",
    );
    expect(ptBR["sectionsEditor.namedRuleDelete.stillUsed"]).not.toBe(
      en["sectionsEditor.namedRuleDelete.stillUsed"],
    );
  });
});
