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
  sprint: "sprint_abc",
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
      sprint: undefined,
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

describe("project-scoped board", () => {
  test("the route's project seeds the repo filter", () => {
    expect(
      parseBoardSearch({}, { defaultRepo: "acme/site" }).filters.repo,
    ).toBe("acme/site");
  });

  test("an explicit ?repo= beats the route's project", () => {
    expect(
      parseBoardSearch({ repo: "acme/other" }, { defaultRepo: "acme/site" })
        .filters.repo,
    ).toBe("acme/other");
  });

  /** A project with no GitHub attachment scopes nothing — the board stays
   *  org-wide rather than filtering to a repo that does not exist. */
  test("no project repo leaves the board unfiltered", () => {
    expect(parseBoardSearch({}, { defaultRepo: null })).toEqual({
      filters: EMPTY_FILTERS,
      layout: "board",
    });
  });
});
