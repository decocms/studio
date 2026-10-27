import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as realNamedRuleView from "@/components/sections-editor/named-rule-view";
import { isoToLocalInput } from "@/components/sections-editor/named-rule-picker";
import type { NamedRuleChange } from "@/components/sections-editor/use-apply-named-rule";
import {
  bumpCopyEpoch,
  copyScope,
} from "@/components/sections-editor/held-copy";

const SCOPE = { orgSlug: "acme", virtualMcpId: "vm-1", branch: "draft-1" };

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

const START = "2026-11-27T00:00:00-03:00";
const calendar = (end: string) => ({
  campaigns: { __resolveType: "calendar", bf: { start: START, end } },
});
const SEED_END = "2026-12-01T00:00:00-03:00";
const ANA_END = "2026-12-10T18:00:00-03:00";
const BRUNO_END = "2026-12-16T18:00:00-03:00";

/** What the detail asked to save, and how the save answers. */
const saves: Array<NamedRuleChange | null> = [];
let saveAnswer = true;
let holdsCopy = true;

const realView = { ...realNamedRuleView };
afterAll(() => {
  mock.module("@/components/sections-editor/named-rule-view", () => realView);
});
mock.module("@/components/sections-editor/named-rule-view", () => ({
  ...realView,
  useNamedRuleView: () => ({
    uses: null,
    apply: async () => ({ ok: true }),
    reread: async () => null,
    planStored: async () => null,
    isPending: false,
    holdsCopy,
    openName: "bf",
    setOpenName: () => {},
    creating: false,
    setCreating: () => {},
    blocked: null,
    missing: [],
    missingNames: 0,
    save: async (change: NamedRuleChange | null) => {
      saves.push(change);
      return saveAnswer;
    },
    create: () => {},
    undo: () => {},
  }),
}));

const { CampaignsView } = await import("./campaigns-view");

beforeEach(() => {
  saves.length = 0;
  saveAnswer = true;
  holdsCopy = true;
});

/**
 * Types into a controlled field: happy-dom doesn't deliver input events to
 * React here, so this calls the field's own `onChange`.
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

function view(decofile: Record<string, unknown>) {
  return (
    <CampaignsView
      {...SCOPE}
      decofile={decofile}
      meta={meta as never}
      onOpenUse={() => {}}
    />
  );
}

function setup(decofile: Record<string, unknown>) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = render(view(decofile), { wrapper });
  const body = within(rendered.container);
  return {
    body,
    rerender: (next: Record<string, unknown>) => rendered.rerender(view(next)),
    // By id and by key too: a test file run before this one may leave the
    // copy as its keys.
    ends: () =>
      rendered.container.querySelector<HTMLInputElement>("#campaign-end")!,
    saveDates: () =>
      body.getByRole("button", {
        name: /^(Save dates|sandbox\.dateCampaigns\.saveDates)$/,
      }) as HTMLButtonElement,
  };
}

describe("a campaign's dates on a hosted v8 draft", () => {
  test('after "Take theirs", the form shows their dates and has nothing to save', () => {
    const { ends, saveDates, rerender } = setup(calendar(SEED_END));
    typeInto(ends(), isoToLocalInput(ANA_END));
    expect(saveDates().disabled).toBe(false);
    // The reconcile kept Bruno's dates: the cache holds them, and the
    // editors of `campaigns` are told to show the draft's copy.
    rerender(calendar(BRUNO_END));
    act(() => bumpCopyEpoch(copyScope(SCOPE), "campaigns"));
    expect(ends().value).toBe(isoToLocalInput(BRUNO_END));
    expect(saveDates().disabled).toBe(true);
  });

  test("an untouched form follows the draft, with nothing to save", () => {
    const { ends, saveDates, rerender } = setup(calendar(SEED_END));
    rerender(calendar(BRUNO_END));
    expect(ends().value).toBe(isoToLocalInput(BRUNO_END));
    expect(saveDates().disabled).toBe(true);
  });

  test("a save is guarded by the copy the form shows, even when a poll brought a newer one", () => {
    const { ends, saveDates, rerender } = setup(calendar(SEED_END));
    typeInto(ends(), isoToLocalInput(ANA_END));
    rerender(calendar(BRUNO_END));
    // The typed date stays: it is the user's, and the save asks about it.
    expect(ends().value).toBe(isoToLocalInput(ANA_END));
    act(() => saveDates().click());
    expect(saves).toHaveLength(1);
    expect(saves[0]?.basis).toEqual(calendar(SEED_END));
  });

  test("after its own save, the next one is guarded by what it saved", async () => {
    const { ends, saveDates, rerender } = setup(calendar(SEED_END));
    typeInto(ends(), isoToLocalInput(ANA_END));
    await act(async () => saveDates().click());
    const saved = saves[0]!.writes.campaigns;
    // The draft holds the save.
    rerender({ campaigns: saved });
    expect(ends().value).toBe(isoToLocalInput(ANA_END));
    expect(saveDates().disabled).toBe(true);
    typeInto(ends(), isoToLocalInput(BRUNO_END));
    await act(async () => saveDates().click());
    expect(saves[1]?.basis).toEqual({ campaigns: saved });
  });
});

describe("a campaign's dates elsewhere (Fast Preview, Localhost)", () => {
  test("the form keeps what it was seeded with, as before", () => {
    holdsCopy = false;
    const { ends, rerender } = setup(calendar(SEED_END));
    rerender(calendar(BRUNO_END));
    expect(ends().value).toBe(isoToLocalInput(SEED_END));
  });
});
