import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as realNamedRuleView from "@/components/sections-editor/named-rule-view";
import * as realPanelNavigate from "./use-panel-navigate";
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

const tests = (hero: number) => ({
  experiments: { __resolveType: "split-traffic", hero },
});

const saves: Array<NamedRuleChange | null> = [];
let holdsCopy = true;
let openName: string | null = "hero";
const opened: Array<string | null> = [];
let cleared = 0;

const realView = { ...realNamedRuleView };
const realNavigate = { ...realPanelNavigate };
afterAll(() => {
  mock.module("@/components/sections-editor/named-rule-view", () => realView);
  mock.module("./use-panel-navigate", () => realNavigate);
});
mock.module("./use-panel-navigate", () => ({
  ...realNavigate,
  usePanelNavigate: () => ({ openPanel: () => {} }),
}));
mock.module("@/components/sections-editor/named-rule-view", () => ({
  ...realView,
  useNamedRuleView: () => ({
    published: null,
    live: { state: "loading" },
    apply: async () => ({ ok: true }),
    reread: async () => null,
    isPending: false,
    holdsCopy,
    openName,
    setOpenName: (name: string | null) => opened.push(name),
    creating: false,
    setCreating: () => {},
    blocked: null,
    save: async (change: NamedRuleChange | null) => {
      saves.push(change);
      return false;
    },
    create: () => {},
    undo: () => {},
  }),
}));

const { ExperimentsBlockReady } = await import("./experiments-block-tab");

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  saves.length = 0;
  holdsCopy = true;
  openName = "hero";
  opened.length = 0;
  cleared = 0;
});

function view(decofile: Record<string, unknown>) {
  return (
    <ExperimentsBlockReady
      {...SCOPE}
      threadId={null}
      decofile={decofile}
      meta={meta as never}
    />
  );
}

function setup(decofile: Record<string, unknown>) {
  const rendered = render(view(decofile), { wrapper: Providers });
  const body = within(rendered.container);
  return {
    rerender: (next: Record<string, unknown>) => rendered.rerender(view(next)),
    share: () => Number(body.getByRole("slider").getAttribute("aria-valuenow")),
    nudge: () => {
      const slider = body.getByRole("slider");
      act(() => {
        slider.focus();
        fireEvent.keyDown(slider, { key: "ArrowRight" });
      });
    },
    save: () => body.getByRole("button", { name: "Save" }) as HTMLButtonElement,
    saveShown: () => body.queryByRole("button", { name: "Save" }) !== null,
  };
}

describe("an A/B test's share on a hosted v8 draft", () => {
  test("a save is guarded by the copy the share was moved on", async () => {
    const { nudge, rerender, save, share } = setup(tests(10));
    nudge();
    expect(share()).toBe(11);
    // A poll brought someone else's share meanwhile.
    rerender(tests(30));
    expect(share()).toBe(11);
    await act(async () => save().click());
    expect(saves[0]?.basis).toEqual(tests(10));
  });

  test("after a reconcile, the share shows the draft's and has nothing to save", () => {
    const { nudge, rerender, saveShown, share } = setup(tests(10));
    nudge();
    rerender(tests(30));
    act(() => bumpCopyEpoch(copyScope(SCOPE), "experiments"));
    expect(share()).toBe(30);
    expect(saveShown()).toBe(false);
  });

  test("Save shows only once the share is moved", () => {
    const { nudge, saveShown } = setup(tests(10));
    expect(saveShown()).toBe(false);
    nudge();
    expect(saveShown()).toBe(true);
  });
});

describe("the list, with a slot under it (the Experiments app)", () => {
  function list(live?: Parameters<typeof ExperimentsBlockReady>[0]["live"]) {
    openName = null;
    return within(
      render(
        <Providers>
          <ExperimentsBlockReady
            {...SCOPE}
            threadId={null}
            decofile={tests(10)}
            meta={meta as never}
            live={live}
          />
        </Providers>,
      ).container,
    );
  }

  test("keeps every edit control and renders the slot with the draft", () => {
    const seen: Array<Record<string, unknown>> = [];
    const body = list((ctx) => {
      seen.push(ctx.draft);
      return (
        <button type="button" onClick={() => ctx.openTest("hero")}>
          live slot
        </button>
      );
    });
    expect(body.getAllByText("New A/B test").length).toBeGreaterThan(0);
    expect(body.getAllByTestId("experiment-v8-row")).toHaveLength(1);
    expect(seen.at(-1)).toEqual(tests(10));
    act(() => body.getByRole("button", { name: "live slot" }).click());
    expect(opened).toEqual(["hero"]);
  });

  test("hands the slot the strict live read, not the lenient one", () => {
    const reads: unknown[] = [];
    list((ctx) => {
      reads.push(ctx.published);
      return null;
    });
    expect(reads.at(-1)).toEqual({ state: "loading" });
  });

  test("a ?test= the draft doesn't have is dropped from the URL", () => {
    openName = null;
    const open = (name: string | null) => ({
      name,
      set: () => {},
      clear: () => {
        cleared += 1;
      },
    });
    const ui = (name: string | null) => (
      <Providers>
        <ExperimentsBlockReady
          {...SCOPE}
          threadId={null}
          decofile={tests(10)}
          meta={meta as never}
          open={open(name)}
        />
      </Providers>
    );
    // The mocked view reads the open name from `openName`.
    openName = "gone";
    const view = render(ui("gone"));
    expect(cleared).toBeGreaterThan(0);
    expect(
      within(view.container).getAllByTestId("experiment-v8-row"),
    ).toHaveLength(1);
    cleared = 0;
    openName = "hero";
    view.rerender(ui("hero"));
    expect(cleared).toBe(0);
  });

  test("a row opens its test in place, and closes it again", () => {
    const body = list();
    expect(body.getByText("1 running")).toBeTruthy();
    expect(body.queryByTestId("experiment-v8-detail")).toBeNull();
    const toggle = body.getByRole("button", { name: "hero" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(opened).toEqual(["hero"]);

    openName = "hero";
    const open = within(
      render(
        <Providers>
          <ExperimentsBlockReady
            {...SCOPE}
            threadId={null}
            decofile={tests(10)}
            meta={meta as never}
          />
        </Providers>,
      ).container,
    );
    expect(open.getAllByTestId("experiment-v8-row")).toHaveLength(1);
    expect(open.getByTestId("experiment-v8-detail")).toBeTruthy();
    act(() => open.getByRole("button", { name: "hero" }).click());
    expect(opened).toEqual(["hero", null]);
  });

  test("without a slot, the list is as before", () => {
    const body = list();
    expect(body.queryByText("live slot")).toBeNull();
    expect(body.getAllByTestId("experiment-v8-row")).toHaveLength(1);
  });
});
