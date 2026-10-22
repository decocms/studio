import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { beforeAll, describe, expect, test } from "bun:test";
import { render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishCodeTab, PublishCompare } from "./cms-publish-compare.tsx";
import type { PublishChange } from "./publish-change-summary.ts";

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

beforeAll(() => {
  // The panes are iframes of the site; nothing here needs them to load.
  const happyDOM = (
    window as unknown as {
      happyDOM?: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM;
  if (happyDOM) happyDOM.settings.disableIframePageLoading = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const experiments: PublishChange = {
  kind: "block",
  blockKey: "experiments",
  name: "Experiments",
  pagePath: null,
  isSiteApp: false,
  status: "edited",
  filepaths: [],
  entry: { name: "experiments", version: "v1" },
  sections: [],
  fromJson: { __resolveType: "split-traffic", hero: 50 },
  toJson: { __resolveType: "split-traffic", hero: 20 },
};

const page: PublishChange = {
  ...experiments,
  kind: "page",
  blockKey: "pages-home",
  name: "Home",
  pagePath: "/",
  entry: { name: "pages-home", version: "v1" },
  fromJson: { __resolveType: "page", path: "/", sections: [] },
  toJson: { __resolveType: "page", path: "/", sections: [{}] },
};

function compare(change: PublishChange, previewServerUrl: string | null) {
  return (
    <PublishCompare
      change={change}
      diff={null}
      bodyPending={false}
      previewServerUrl={previewServerUrl}
      draft={null}
      lastPage={null}
      v8={{ blocks: {} }}
    />
  );
}

describe("the publish panel's Code tab", () => {
  test("the site editor keeps it", () => {
    const view = render(compare(page, "https://site.example"));
    const body = within(view.container);
    expect(body.getByRole("tab", { name: "Code" })).toBeTruthy();
    expect(body.getByRole("tab", { name: "Side by side" })).toBeTruthy();
    view.unmount();
  });

  test("Experiments and Calendar show pages only", () => {
    const view = render(
      <PublishCodeTab value={false}>
        {compare(page, "https://site.example")}
      </PublishCodeTab>,
    );
    const body = within(view.container);
    expect(body.queryByRole("tab", { name: "Code" })).toBeNull();
    expect(body.getByRole("tab", { name: "Side by side" })).toBeTruthy();
    view.unmount();
  });

  test("a change with no page to show says so instead of showing code", () => {
    const view = render(
      <PublishCodeTab value={false}>{compare(experiments, null)}</PublishCodeTab>,
    );
    const body = within(view.container);
    expect(body.queryByRole("tab")).toBeNull();
    expect(body.getByText("Nothing to preview")).toBeTruthy();
    expect(view.container.textContent).not.toContain("split-traffic");
    view.unmount();
  });

  test("without the provider, the same change goes to its code", () => {
    // Its sides not loaded yet: the code view says so (no editor to load).
    const view = render(
      compare({ ...experiments, fromJson: null, toJson: null }, null),
    );
    const body = within(view.container);
    expect(body.getByRole("tab", { name: "Code" })).toBeTruthy();
    expect(body.queryByText("Nothing to preview")).toBeNull();
    view.unmount();
  });
});
