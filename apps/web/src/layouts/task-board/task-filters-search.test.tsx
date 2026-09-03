import "../../../test/setup";

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { buildProjectIndex } from "@/lib/project-index";
import { TaskFiltersBar, EMPTY_FILTERS } from "./task-filters";

const EMPTY_INDEX = buildProjectIndex([]);
/** A repository no project claims — the bucket is titled `owner/name`, which
 *  is what the chip and the option row read. */
const SITE_INDEX = buildProjectIndex([], ["acme/site"]);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

/**
 * cmdk's built-in fuzzy search filters each `CommandItem` by its `value`
 * prop, not by its rendered children — so a hardcoded English `value` (e.g.
 * "Unassigned") makes the option unfindable to a pt-BR user typing its own
 * on-screen label ("Sem atribuição"). Asserting `data-value` (cmdk mirrors
 * `value` there) matches the displayed label is a locale-independent proxy
 * for "this option's search filter matches what the user actually sees" —
 * cmdk itself doesn't apply its filtering pass in this DOM environment.
 */
describe("task filter options — searchable value matches the displayed label", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      LOCALSTORAGE_KEYS.preferences(),
      JSON.stringify({ language: "pt-BR" }),
    );
  });

  test("assignee filter", () => {
    const { getByText } = render(
      <TaskFiltersBar
        filters={EMPTY_FILTERS}
        members={[]}
        tags={[]}
        index={EMPTY_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );
    fireEvent.click(getByText("Responsável"));

    for (const label of ["Qualquer um", "Sem atribuição", "Super Agent"]) {
      const item = getByText(label).closest("[cmdk-item]");
      expect(item?.getAttribute("data-value")).toBe(label);
    }
  });

  test("project filter", () => {
    const { getByText } = render(
      <TaskFiltersBar
        filters={{ ...EMPTY_FILTERS, project: "acme/site" }}
        members={[]}
        tags={[]}
        index={SITE_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );
    fireEvent.click(getByText("acme/site"));

    for (const label of ["Todos os projetos", "Sem projeto"]) {
      const item = getByText(label).closest("[cmdk-item]");
      expect(item?.getAttribute("data-value")).toBe(label);
    }
  });
});

describe("search toggle — collapses when cleared externally", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("an unfocused search chip collapses when 'Clear all' resets filters", () => {
    const { getByPlaceholderText, queryByPlaceholderText, rerender } = render(
      <TaskFiltersBar
        filters={{ ...EMPTY_FILTERS, search: "login" }}
        members={[]}
        tags={[]}
        index={EMPTY_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );

    const input = getByPlaceholderText("Search tasks…");
    fireEvent.blur(input);

    rerender(
      <TaskFiltersBar
        filters={EMPTY_FILTERS}
        members={[]}
        tags={[]}
        index={EMPTY_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );

    expect(queryByPlaceholderText("Search tasks…")).toBeNull();
  });

  test("a focused search box stays open while backspaced to empty", () => {
    const { getByPlaceholderText, rerender } = render(
      <TaskFiltersBar
        filters={{ ...EMPTY_FILTERS, search: "login" }}
        members={[]}
        tags={[]}
        index={EMPTY_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );

    const input = getByPlaceholderText("Search tasks…");
    fireEvent.focus(input);

    rerender(
      <TaskFiltersBar
        filters={EMPTY_FILTERS}
        members={[]}
        tags={[]}
        index={EMPTY_INDEX}
        sprints={[]}
        onChange={() => {}}
        onOpenBoardSettings={() => {}}
      />,
    );

    expect(getByPlaceholderText("Search tasks…")).not.toBeNull();
  });
});
