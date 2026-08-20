import { describe, expect, test } from "bun:test";
import { boardSearchParams, parseBoardSearch } from "./filters-search";
import { EMPTY_FILTERS, type TaskFilters } from "./task-filters";

const filters: TaskFilters = {
  search: "login",
  assignee: "user-1",
  priority: "high",
  due: "today",
  tags: ["tag-1", "tag-2"],
  repo: "acme/site",
};

describe("board search params", () => {
  test("round-trips filters and layout through the URL", () => {
    const params = boardSearchParams(filters, "list");
    expect(parseBoardSearch(params)).toEqual({ filters, layout: "list" });
  });

  test("defaults are omitted from the URL", () => {
    expect(boardSearchParams(EMPTY_FILTERS, "board")).toEqual({
      view: undefined,
      q: undefined,
      assignee: undefined,
      priority: undefined,
      due: undefined,
      tags: undefined,
      repo: undefined,
    });
  });

  test("an empty URL is the empty state", () => {
    expect(parseBoardSearch({})).toEqual({
      filters: EMPTY_FILTERS,
      layout: "board",
    });
  });

  test("unrecognized values are dropped, not trusted", () => {
    expect(
      parseBoardSearch({
        view: "kanban",
        priority: "critical",
        due: "yesterday",
        tags: ",,",
      }),
    ).toEqual({ filters: EMPTY_FILTERS, layout: "board" });
  });
});
