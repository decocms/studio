import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ContentEntry,
  ContentType,
  ContentTypeTree,
} from "./content-types";
import { ContentTypesTable } from "./content-types-table";

const entry = (
  key: string,
  status: ContentEntry["status"],
  path: string,
): ContentEntry => ({
  key,
  block: { __resolveType: "page", name: key, path, sections: [] },
  status,
});
const pages: ContentType = {
  id: "page",
  group: "pages",
  title: "Pages",
  entries: [
    entry("Home", "published", "/"),
    entry("About", "changed", "/about"),
    entry("Gone", "deleted", "/gone"),
  ],
  changed: 2,
};
const tree: ContentTypeTree = {
  pages,
  redirects: null,
  collections: [pages],
  singletons: [],
  all: [pages],
  changed: [],
  statusKnown: true,
};

function setup() {
  const onOpen = mock();
  const onRestore = mock();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ContentTypesTable
        tree={tree}
        type={pages}
        onOpen={onOpen}
        onRestore={onRestore}
        restoring={null}
      />
    </QueryClientProvider>,
  );
  const row = (name: string) =>
    view.getByText(name).closest("tr") as HTMLElement;
  return { view, row, onOpen, onRestore };
}

describe("ContentTypesTable", () => {
  test("a row opens its entry by click and by keyboard", () => {
    const { row, onOpen } = setup();
    fireEvent.click(row("Home"));
    fireEvent.keyDown(row("About"), { key: "Enter" });
    expect(onOpen.mock.calls.map(([, e]) => e.key)).toEqual(["Home", "About"]);
  });

  test("a deleted row doesn't open; its Restore restores it", () => {
    const { row, onOpen, onRestore } = setup();
    fireEvent.click(row("Gone"));
    const restore = within(row("Gone")).getByRole("button", {
      name: "Restore",
    });
    fireEvent.keyDown(restore, { key: "Enter" });
    fireEvent.click(restore);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRestore.mock.calls.map(([e]) => e.key)).toEqual(["Gone"]);
  });

  test("Changed lists only what the draft changes", () => {
    const { view } = setup();
    fireEvent.click(view.getByRole("radio", { name: /Changed/ }));
    expect(view.queryByText("Home")).toBeNull();
    expect(view.getByText("About")).toBeTruthy();
  });

  test('"/" focuses the search', () => {
    const { view } = setup();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(
      view.getByPlaceholderText("Search pages"),
    );
  });
});
