import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
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

describe("the review frames (publish review)", () => {
  const draft = { kind: "pointer", pointer: "drafts/x.json" } as const;
  const pane = (props: { v8: boolean; onReady?: () => void }) => (
    <PublishCompare
      change={page}
      diff={null}
      bodyPending={false}
      previewServerUrl="https://site.example"
      draft={draft}
      lastPage={null}
      v8={props.v8 ? { blocks: {} } : undefined}
      onReady={props.onReady}
    />
  );
  const frames = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLIFrameElement>("iframe"),
  ];

  test("v8: a frame not measured yet stays hidden instead of showing at full size", () => {
    const view = render(pane({ v8: true }));
    const [before, after] = frames(view.container);
    expect(before!.style.visibility).toBe("hidden");
    expect(after!.style.visibility).toBe("hidden");
    expect(before!.style.transform).toBe("");
    view.unmount();
  });

  test("v7 keeps main's frames (scale 1 until measured)", () => {
    const view = render(pane({ v8: false }));
    const [before] = frames(view.container);
    expect(before!.style.visibility).toBe("");
    expect(before!.style.transform).toBe("scale(1)");
    view.unmount();
  });

  test("v8: another device keeps the page on screen until the new one loads", () => {
    const view = render(pane({ v8: true }));
    for (const frame of frames(view.container)) {
      act(() => {
        fireEvent.load(frame);
      });
    }
    const loaded = frames(view.container);
    expect(loaded).toHaveLength(2);
    act(() => {
      fireEvent.click(
        within(view.container).getByRole("button", { name: "Mobile" }),
      );
    });
    // Each side: the desktop page still there, the mobile one loading under it.
    const both = frames(view.container);
    expect(both).toHaveLength(4);
    expect(both[0]).toBe(loaded[0]!);
    expect(both[0]!.className).not.toContain("opacity-0");
    expect(both[1]!.className).toContain("opacity-0");
    expect(both[1]!.src).toContain("mobile");
    act(() => {
      fireEvent.load(both[1]!);
    });
    const [beforeNow] = frames(view.container);
    expect(beforeNow).toBe(both[1]!);
    expect(beforeNow!.className).not.toContain("opacity-0");
    view.unmount();
  });

  test("v8: says it's ready once both sides have loaded", () => {
    const onReady = mock(() => {});
    const view = render(pane({ v8: true, onReady }));
    const [before, after] = frames(view.container);
    act(() => {
      fireEvent.load(before!);
    });
    expect(onReady).not.toHaveBeenCalled();
    act(() => {
      fireEvent.load(after!);
    });
    expect(onReady).toHaveBeenCalled();
    view.unmount();
  });

  test("v8: Open draft carries the frame's __draft; the panes the bare pointer, the before side off", () => {
    const pointer = "delivery.decocms.com/sites/acme/drafts/s1.json@e3";
    const link =
      "delivery.decocms.com/sites/acme/drafts/s1.json?__variant=pages-home%40sections%3D1@e3";
    const view = render(
      <PublishCompare
        change={page}
        diff={null}
        bodyPending={false}
        previewServerUrl="https://site.example"
        draft={{ kind: "pointer", pointer, link }}
        lastPage={null}
        v8={{ blocks: {} }}
      />,
    );
    const open =
      document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(new URL(open.href).searchParams.get("__draft")).toBe(link);
    const [before, after] = frames(view.container);
    expect(new URL(before!.src).searchParams.get("__draft")).toBe("off");
    expect(new URL(after!.src).searchParams.get("__draft")).toBe(pointer);
    view.unmount();
  });

  test("v8: a pane with no page to load is ready at once", () => {
    const onReady = mock(() => {});
    const view = render(
      <PublishCodeTab value={false}>
        <PublishCompare
          change={page}
          diff={null}
          bodyPending={false}
          previewServerUrl={null}
          draft={null}
          lastPage={null}
          v8={{ blocks: {} }}
          onReady={onReady}
        />
      </PublishCodeTab>,
    );
    expect(onReady).toHaveBeenCalled();
    view.unmount();
  });
});
