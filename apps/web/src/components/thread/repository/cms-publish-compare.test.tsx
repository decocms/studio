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
    const code: PublishChange = {
      ...experiments,
      kind: "other",
      blockKey: null,
      entry: undefined,
      filepaths: ["src/sections/Hero.tsx"],
    };
    const view = render(
      <PublishCodeTab value={false}>
        {compare(code, "https://site.example")}
      </PublishCodeTab>,
    );
    const body = within(view.container);
    expect(body.queryByRole("tab")).toBeNull();
    expect(body.getByText("Nothing to preview")).toBeTruthy();
    expect(view.container.textContent).not.toContain("split-traffic");
    view.unmount();
  });

  test("with no site address yet, it says the preview isn't ready, not that no page shows it", () => {
    const view = render(
      <PublishCodeTab value={false}>{compare(page, null)}</PublishCodeTab>,
    );
    const body = within(view.container);
    expect(body.queryByRole("tab")).toBeNull();
    expect(body.queryByText("Nothing to preview")).toBeNull();
    expect(body.getByText("Preview not ready yet")).toBeTruthy();
    view.unmount();
  });

  test("while the page that shows a saved section is found, it waits", () => {
    const section: PublishChange = {
      ...experiments,
      blockKey: "Hero",
      name: "Hero",
      entry: { name: "Hero", version: "v1" },
      fromJson: { __resolveType: "site/sections/Hero.tsx", title: "a" },
      toJson: { __resolveType: "site/sections/Hero.tsx", title: "b" },
    };
    const view = render(
      <PublishCodeTab value={false}>
        <PublishCompare
          change={section}
          diff={null}
          bodyPending={false}
          previewServerUrl="https://site.example"
          draft={null}
          lastPage={null}
          v8={{ blocks: null }}
        />
      </PublishCodeTab>,
    );
    const body = within(view.container);
    expect(body.queryByText("Nothing to preview")).toBeNull();
    expect(body.queryByText("Preview not ready yet")).toBeNull();
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
