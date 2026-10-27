import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, render as rtlRender } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import * as realBackend from "@/components/sections-editor/use-content-backend";
import { en } from "@/i18n/en/index.ts";
import { KEYS } from "@/lib/query-keys";

/** The project's backend, as `useContentBackend` answers it. */
const project = { backend: { kind: "protocol", source: "github" } as object };
const backendModule = { ...realBackend };
afterAll(() => {
  mock.module(
    "@/components/sections-editor/use-content-backend",
    () => backendModule,
  );
});
mock.module("@/components/sections-editor/use-content-backend", () => ({
  ...realBackend,
  useContentBackend: () => project.backend,
}));

const { HeldBlockView } = await import("./held-block-view");
const { bumpCopyEpoch, copyScope } = await import(
  "@/components/sections-editor/held-copy"
);

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const scope = { orgSlug: "acme", virtualMcpId: "vm", branch: "draft" };

/** A form that seeds its own copy once, as the editors do. */
function Form({ seed }: { seed: string }) {
  const [value] = useState(seed);
  return <p data-testid="form">{value}</p>;
}

function view(seed: string, present: boolean | undefined, blockKey = "Footer") {
  return (
    <HeldBlockView {...scope} blockKey={blockKey} present={present}>
      <Form seed={seed} />
    </HeldBlockView>
  );
}

describe("HeldBlockView (an editor keeping its own copy)", () => {
  test("on a hosted v8 draft, a reconcile reseeds the form from the draft's copy", () => {
    project.backend = { kind: "protocol", source: "github" };
    const { getByTestId, rerender } = render(view("mine", true));
    // Their version is in the cache now; the form still shows its copy.
    rerender(view("theirs", true));
    expect(getByTestId("form").textContent).toBe("mine");
    act(() => bumpCopyEpoch(copyScope(scope), "Footer"));
    expect(getByTestId("form").textContent).toBe("theirs");
  });

  test("a block the draft no longer has shows as deleted: no form to type in", () => {
    project.backend = { kind: "protocol", source: "github" };
    const { queryByTestId, getByText } = render(view("mine", false));
    expect(queryByTestId("form")).toBeNull();
    expect(getByText(en["sectionsEditor.reconcile.deletedTitle"])).toBeTruthy();
    expect(
      getByText(en["sectionsEditor.reconcile.deletedDescription"]),
    ).toBeTruthy();
  });

  test("a deleted block that was never published offers no way back through Publish", () => {
    project.backend = {
      kind: "protocol",
      source: "github",
      cacheKeySuffix: "",
    };
    // The draft created it, then deleted it: its tombstone, no listed change.
    queryClient.setQueryData(KEYS.contentChanges("acme/vm/draft"), {
      revision: "r1",
      changes: {},
    });
    queryClient.setQueryData(KEYS.contentDraftTombstones("acme/vm/draft"), [
      "Footer",
    ]);
    const { getByText, queryByText } = render(view("mine", false));
    expect(
      getByText(
        en["sectionsEditor.reconcile.deletedNeverPublishedDescription"],
      ),
    ).toBeTruthy();
    expect(
      queryByText(en["sectionsEditor.reconcile.deletedDescription"]),
    ).toBeNull();
    queryClient.removeQueries({
      queryKey: KEYS.contentChanges("acme/vm/draft"),
    });
  });

  test("another block in the same view (a move renamed it) is no remount", () => {
    project.backend = { kind: "protocol", source: "github" };
    act(() => bumpCopyEpoch(copyScope(scope), "Footer"));
    const { getByTestId, rerender } = render(view("mine", true));
    rerender(view("theirs", true, "Footer-renamed"));
    expect(getByTestId("form").textContent).toBe("mine");
  });

  for (const backend of [
    { kind: "decofile" },
    { kind: "protocol", source: "sandbox" },
    { kind: "protocol", source: "local" },
  ]) {
    test(`renders the editor as before elsewhere (${JSON.stringify(backend)})`, () => {
      project.backend = backend;
      const { getByTestId, rerender } = render(view("mine", false));
      expect(getByTestId("form").textContent).toBe("mine");
      rerender(view("theirs", false));
      act(() => bumpCopyEpoch(copyScope(scope), "Footer"));
      expect(getByTestId("form").textContent).toBe("mine");
    });
  }
});
