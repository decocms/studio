import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContentType, ContentTypeTree } from "./content-types";
import {
  ContentTypesSidebar,
  type ContentTypesView,
} from "./content-types-sidebar";

const header: ContentType = {
  id: "site-header",
  group: "sections",
  title: "Header",
  entries: [
    {
      key: "Header",
      block: { __resolveType: "site-header" },
      status: "published",
    },
  ],
  changed: 0,
};
const settingsType: ContentType = {
  id: "cms-settings",
  group: "content",
  title: "Settings",
  entries: [
    { key: "CMS", block: { __resolveType: "cms-settings" }, status: "changed" },
  ],
  changed: 1,
};
const tree = (settings: ContentType | null): ContentTypeTree => ({
  pages: null,
  redirects: null,
  collections: [],
  singletons: [header],
  all: [header],
  settings,
  changed: settings
    ? [{ type: settingsType, entry: settingsType.entries[0]! }]
    : [],
  statusKnown: true,
});

function setup(opts: {
  settings: { changed: boolean } | null;
  saved?: boolean;
  view?: ContentTypesView;
}) {
  const onSelect = mock();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ContentTypesSidebar
        tree={tree(opts.saved ? settingsType : null)}
        view={opts.view ?? { kind: "seo" }}
        onSelect={onSelect}
        onOpenEntry={mock()}
        settings={opts.settings}
      />
    </QueryClientProvider>,
  );
  return { view, onSelect };
}

describe("ContentTypesSidebar's Settings part", () => {
  test("shows with no CMS block saved, and opens the Settings page", () => {
    const { view, onSelect } = setup({ settings: { changed: false } });
    const part = view.getByTestId("content-sidebar-settings");
    fireEvent.click(within(part).getByRole("button", { name: "Settings" }));
    expect(onSelect.mock.calls).toEqual([[{ kind: "settings" }]]);
    // No changed dot.
    expect(within(part).queryByTitle("Changed in draft")).toBeNull();
  });

  test("is not among the Singletons", () => {
    const { view } = setup({ settings: { changed: true }, saved: true });
    const part = view.getByTestId("content-sidebar-settings");
    // One Settings row, the pinned one.
    expect(view.getAllByRole("button", { name: /^Settings/ })).toEqual([
      within(part).getByRole("button", { name: /^Settings/ }),
    ]);
    expect(view.getByRole("button", { name: "Header" })).toBeTruthy();
  });

  test("marks a draft change with the changed dot", () => {
    const { view } = setup({ settings: { changed: true }, saved: true });
    const part = view.getByTestId("content-sidebar-settings");
    expect(within(part).getByTitle("Changed in draft")).toBeTruthy();
  });

  test("is selected on its page", () => {
    const { view } = setup({
      settings: { changed: false },
      view: { kind: "settings" },
    });
    const part = view.getByTestId("content-sidebar-settings");
    expect(within(part).getByRole("button").getAttribute("aria-current")).toBe(
      "page",
    );
  });

  test("absent when the site's framework has no CMS settings type", () => {
    const { view } = setup({ settings: null });
    expect(view.queryByTestId("content-sidebar-settings")).toBeNull();
  });
});
