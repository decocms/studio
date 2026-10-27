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
    uses: null,
    apply: async () => ({ ok: true }),
    reread: async () => null,
    planStored: async () => null,
    isPending: false,
    holdsCopy,
    openName: "hero",
    setOpenName: () => {},
    creating: false,
    setCreating: () => {},
    blocked: null,
    missing: [],
    missingNames: 0,
    save: async (change: NamedRuleChange | null) => {
      saves.push(change);
      return false;
    },
    create: () => {},
    undo: () => {},
  }),
}));

const { ExperimentsBlockReady } = await import("./experiments-block-tab");

beforeEach(() => {
  saves.length = 0;
  holdsCopy = true;
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
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = render(view(decofile), { wrapper });
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
    const { nudge, rerender, save, share } = setup(tests(10));
    nudge();
    rerender(tests(30));
    act(() => bumpCopyEpoch(copyScope(SCOPE), "experiments"));
    expect(share()).toBe(30);
    expect(save().disabled).toBe(true);
  });
});
