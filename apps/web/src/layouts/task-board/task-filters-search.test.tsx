import "../../../test/setup";

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { TaskFiltersBar, EMPTY_FILTERS } from "./task-filters";

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
        repos={[]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getByText("Responsável"));

    for (const label of ["Qualquer um", "Sem atribuição", "Super Agent"]) {
      const item = getByText(label).closest("[cmdk-item]");
      expect(item?.getAttribute("data-value")).toBe(label);
    }
  });

  test("repo filter", () => {
    const { getByText } = render(
      <TaskFiltersBar
        filters={{ ...EMPTY_FILTERS, repo: "acme/site" }}
        members={[]}
        tags={[]}
        repos={["acme/site"]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getByText("acme/site"));

    for (const label of ["Qualquer repositório", "Sem repositório"]) {
      const item = getByText(label).closest("[cmdk-item]");
      expect(item?.getAttribute("data-value")).toBe(label);
    }
  });
});
