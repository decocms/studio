import { describe, expect, test } from "bun:test";
import {
  boardSearchParams,
  type BoardView,
  parseBoardSearch,
  visibleSelection,
} from "./filters-search";
import { EMPTY_FILTERS, type TaskFilters } from "./task-filters-core";

const EMPTY_VIEW: BoardView = {
  filters: EMPTY_FILTERS,
  layout: "board",
  groupBy: null,
  subgroupBy: null,
  sortBy: null,
  sortDirection: "asc",
};

const filters: TaskFilters = {
  search: "login",
  assignee: "user-1",
  priority: "high",
  due: "today",
  tags: ["tag-1", "tag-2"],
  project: "acme/site",
};

describe("board search params", () => {
  test("round-trips filters, layout, grouping and sorting through the URL", () => {
    const view: BoardView = {
      filters,
      layout: "list",
      groupBy: "assignee",
      subgroupBy: "status",
      sortBy: "due",
      sortDirection: "desc",
    };
    expect(parseBoardSearch(boardSearchParams(view))).toEqual(view);
  });

  test("a sort's default direction stays out of the URL", () => {
    const due = boardSearchParams({
      ...EMPTY_VIEW,
      sortBy: "due",
      sortDirection: "asc",
    });
    expect(due.sort).toBe("due");
    expect(due.dir).toBeUndefined();
    expect(parseBoardSearch({ sort: "priority" }).sortDirection).toBe("desc");
    expect(
      boardSearchParams({ ...EMPTY_VIEW, sortDirection: "desc" }).dir,
    ).toBeUndefined();
  });

  test("a sub-group needs a different group above it", () => {
    expect(parseBoardSearch({ subgroup: "status" }).subgroupBy).toBeNull();
    expect(
      parseBoardSearch({ group: "status", subgroup: "status" }).subgroupBy,
    ).toBeNull();
    expect(
      boardSearchParams({ ...EMPTY_VIEW, layout: "list", subgroupBy: "status" })
        .subgroup,
    ).toBeUndefined();
  });

  test("the feed is a third view, carried the same way", () => {
    expect(boardSearchParams({ ...EMPTY_VIEW, layout: "feed" }).view).toBe(
      "feed",
    );
    expect(parseBoardSearch({ view: "feed" }).layout).toBe("feed");
  });

  test("a mount's own default layout drops out of the URL, Board does not", () => {
    expect(
      boardSearchParams({ ...EMPTY_VIEW, layout: "feed" }, "feed").view,
    ).toBeUndefined();
    expect(boardSearchParams({ ...EMPTY_VIEW }, "feed").view).toBe("board");
    expect(parseBoardSearch({}, "feed").layout).toBe("feed");
    expect(parseBoardSearch({ view: "board" }, "feed").layout).toBe("board");
  });

  test("defaults are omitted from the URL", () => {
    expect(boardSearchParams(EMPTY_VIEW)).toEqual({
      view: undefined,
      group: undefined,
      subgroup: undefined,
      sort: undefined,
      dir: undefined,
      q: undefined,
      assignee: undefined,
      priority: undefined,
      due: undefined,
      tags: undefined,
      repo: undefined,
    });
  });

  test("an empty URL is the empty state", () => {
    expect(parseBoardSearch({})).toEqual(EMPTY_VIEW);
  });

  test("unrecognized values are dropped, not trusted", () => {
    expect(
      parseBoardSearch({
        view: "kanban",
        group: "due",
        subgroup: "due",
        sort: "status",
        dir: "sideways",
        priority: "critical",
        due: "yesterday",
        tags: ",,",
      }),
    ).toEqual(EMPTY_VIEW);
  });
});

/**
 * The ambient scope used to seed the board's own filter, which made the two
 * indistinguishable and — because that filter is exact-match — hid every
 * repo-less card the moment a project was picked. They are separate concepts
 * now: these tests are the inverted form of the ones that encoded the old
 * behaviour, and they still hold with the filter speaking projects.
 */
describe("the ambient project scope does not touch the board's filter", () => {
  test("a scoped route leaves filters.project null", () => {
    expect(parseBoardSearch({}).filters.project).toBeNull();
  });

  test("an explicit ?repo= is still the only thing that sets it", () => {
    expect(parseBoardSearch({ repo: "acme/other" }).filters.project).toBe(
      "acme/other",
    );
  });
});

/**
 * The URL key stayed `repo` while its value domain widened to project index
 * bucket ids. Both routes' `validateSearch` enumerate their params and strip
 * anything else, and every `?repo=owner/name` link already shared has to keep
 * working — so the key is a contract, and these two cases are it.
 */
describe("the ?repo= param carries a bucket id", () => {
  test("a project's bucket id is written to ?repo=", () => {
    expect(
      boardSearchParams({
        ...EMPTY_VIEW,
        filters: { ...EMPTY_FILTERS, project: "acme/site" },
      }).repo,
    ).toBe("acme/site");
  });

  test("a repo-less project's id round-trips through it too", () => {
    expect(parseBoardSearch({ repo: "vir_x" }).filters.project).toBe("vir_x");
    expect(
      boardSearchParams({
        ...EMPTY_VIEW,
        filters: { ...EMPTY_FILTERS, project: "vir_x" },
      }).repo,
    ).toBe("vir_x");
  });
});

describe("visibleSelection", () => {
  const visible = [{ id: "a" }, { id: "b" }];

  test("keeps ids that are still on screen", () => {
    expect(visibleSelection(new Set(["a"]), visible)).toEqual(new Set(["a"]));
  });

  /** The load-bearing one: a scope change hides cards without touching the
   *  selection state, and bulk delete must not reach them. */
  test("drops ids a scope or filter change hid", () => {
    expect(visibleSelection(new Set(["a", "hidden"]), visible)).toEqual(
      new Set(["a"]),
    );
    expect(visibleSelection(new Set(["hidden"]), visible)).toEqual(new Set());
  });

  test("an empty board selects nothing", () => {
    expect(visibleSelection(new Set(["a"]), [])).toEqual(new Set());
  });
});
