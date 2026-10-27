import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildProjectIndex } from "@/lib/project-index";
import { EMPTY_FILTERS } from "./task-filters-core";
import { AppliedFiltersBar } from "./view-controls";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const project = {
  id: "p1",
  title: "Storefront",
  created_at: "2026-01-01T00:00:00Z",
  metadata: {},
} as unknown as VirtualMCPEntity;

const bar = (scope: Parameters<typeof AppliedFiltersBar>[0]["scope"]) => (
  <AppliedFiltersBar
    filters={EMPTY_FILTERS}
    items={[]}
    members={[]}
    tags={[]}
    sprints={[]}
    index={buildProjectIndex([project])}
    onChange={() => {}}
    scope={scope}
  />
);

describe("AppliedFiltersBar project scope chip", () => {
  it("names the project and lifts the scope from its X", () => {
    let cleared = 0;
    const { getByText, getByRole } = render(
      bar({ project, onClear: () => cleared++ }),
    );
    expect(getByText("Project")).toBeInTheDocument();
    expect(getByText("Storefront")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Show all projects" }));
    expect(cleared).toBe(1);
  });

  it("shows nothing on the org-wide board without filters", () => {
    const { container } = render(bar(undefined));
    expect(container).toBeEmptyDOMElement();
  });
});
