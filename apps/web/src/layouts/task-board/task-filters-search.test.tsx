import { setupComponentTest } from "../../../test/setup";

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderBare,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { buildProjectIndex } from "@/lib/project-index";
import type { OrgTag } from "./config";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
import { EMPTY_FILTERS } from "./task-filters-core";
import { TaskFilterButton } from "./view-controls";

const TAG: OrgTag = {
  id: "tag_1",
  organizationId: "org_1",
  name: "bug",
  color: "red",
  createdAt: "2026-01-01T00:00:00.000Z",
};
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

setupComponentTest();

/** cmdk filters each row by its `value` prop, never by its rendered children. */
describe("filter menu — searchable value matches the displayed labels", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      LOCALSTORAGE_KEYS.preferences(),
      JSON.stringify({ language: "pt-BR" }),
    );
  });

  /** cmdk selects a row on pointer move, and that selection is what opens the
   *  field's side panel — so browsing is a hover, never a click. */
  const hover = (label: HTMLElement) =>
    fireEvent.pointerMove(label.closest("[cmdk-item]") ?? label);

  /** Radix mounts the popover's content in an effect, so the rows are not in
   *  the DOM on the tick the trigger is clicked. */
  const openMenu = async (index = EMPTY_INDEX, tags: OrgTag[] = []) => {
    const result = render(
      <TaskFilterButton
        filters={EMPTY_FILTERS}
        items={[]}
        members={[]}
        tags={tags}
        index={index}
        onChange={() => {}}
      />,
    );
    fireEvent.click(result.getByLabelText("Filtrar"));
    await waitFor(() => result.getByText("Responsável"));
    return result;
  };

  test("the field rows are searchable by their own labels", async () => {
    const { getByText } = await openMenu(EMPTY_INDEX, [TAG]);

    for (const label of [
      "Responsável",
      "Prioridade",
      "Data de vencimento",
      "Tags",
      "Projeto",
    ]) {
      const item = getByText(label).closest("[cmdk-item]");
      expect(item?.getAttribute("data-value")).toBe(label);
    }
  });

  /** A field with no values narrows nothing, so offering it opens onto an empty
   *  panel. Tags is the only field whose options can be empty. */
  test("a field with no values is not offered at all", async () => {
    const { queryByText } = await openMenu();

    expect(queryByText("Tags")).toBeNull();
    expect(queryByText("Prioridade")).not.toBeNull();
  });

  test("hovering a field opens its values, by their displayed labels", async () => {
    const { getByText, getAllByText, findAllByText } = await openMenu();
    hover(getByText("Prioridade"));
    await findAllByText("Alta");

    for (const label of ["Alta", "Média", "Baixa"]) {
      expect(getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  test("a repository bucket is offered under the project field", async () => {
    const { getByText, getAllByText, findAllByText } =
      await openMenu(SITE_INDEX);
    hover(getByText("Projeto"));
    await findAllByText("acme/site");

    expect(getAllByText("acme/site").length).toBeGreaterThan(0);
    expect(getAllByText("Sem projeto").length).toBeGreaterThan(0);
  });
});

describe("search toggle — collapses when cleared externally", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("an unfocused search chip collapses when the filters are reset", () => {
    const { getByPlaceholderText, queryByPlaceholderText, rerender } = render(
      <SearchToggle
        value="login"
        onChange={() => {}}
        placeholder="Search tasks…"
      />,
    );

    const input = getByPlaceholderText("Search tasks…");
    fireEvent.blur(input);

    rerender(
      <SearchToggle value="" onChange={() => {}} placeholder="Search tasks…" />,
    );

    expect(queryByPlaceholderText("Search tasks…")).toBeNull();
  });

  test("a focused search box stays open while backspaced to empty", () => {
    const { getByPlaceholderText, rerender } = render(
      <SearchToggle
        value="login"
        onChange={() => {}}
        placeholder="Search tasks…"
      />,
    );

    const input = getByPlaceholderText("Search tasks…");
    fireEvent.focus(input);

    rerender(
      <SearchToggle value="" onChange={() => {}} placeholder="Search tasks…" />,
    );

    expect(getByPlaceholderText("Search tasks…")).not.toBeNull();
  });
});
