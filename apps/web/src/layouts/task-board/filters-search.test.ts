import { describe, expect, test } from "bun:test";
import {
  boardSearchParams,
  parseBoardSearch,
  taskMatchesScope,
  visibleSelection,
} from "./filters-search";
import { EMPTY_FILTERS, type TaskFilters } from "./task-filters";

const filters: TaskFilters = {
  search: "login",
  assignee: "user-1",
  priority: "high",
  due: "today",
  tags: ["tag-1", "tag-2"],
  project: "acme/site",
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
      boardSearchParams({ ...EMPTY_FILTERS, project: "acme/site" }, "board")
        .repo,
    ).toBe("acme/site");
  });

  test("a repo-less project's id round-trips through it too", () => {
    expect(parseBoardSearch({ repo: "vir_x" }).filters.project).toBe("vir_x");
    expect(
      boardSearchParams({ ...EMPTY_FILTERS, project: "vir_x" }, "board").repo,
    ).toBe("vir_x");
  });
});

describe("taskMatchesScope", () => {
  test("no scope keeps everything", () => {
    expect(taskMatchesScope({ repo: "acme/site" }, null)).toBe(true);
    expect(taskMatchesScope({ repo: null }, null)).toBe(true);
  });

  test("a scope keeps its own repo's cards", () => {
    expect(taskMatchesScope({ repo: "acme/site" }, "acme/site")).toBe(true);
  });

  test("a scope drops another repo's cards", () => {
    expect(taskMatchesScope({ repo: "acme/other" }, "acme/site")).toBe(false);
  });

  /** The load-bearing one. Reports imports and the Jira sync both write no
   *  repo at all, so hiding unassigned cards would empty most boards. */
  test("a scope KEEPS cards with no repo", () => {
    expect(taskMatchesScope({ repo: null }, "acme/site")).toBe(true);
    expect(taskMatchesScope({}, "acme/site")).toBe(true);
  });

  test("matching is case-insensitive, as GitHub is", () => {
    expect(taskMatchesScope({ repo: "Acme/Site" }, "acme/site")).toBe(true);
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
