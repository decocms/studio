import { describe, expect, test } from "bun:test";
import {
  boardSearchParams,
  parseBoardSearch,
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

describe("visibleSelection", () => {
  const visible = [{ id: "a" }, { id: "b" }];

  test("keeps ids that are still on screen", () => {
    expect(visibleSelection(new Set(["a"]), visible)).toEqual(new Set(["a"]));
  });

  /** A filter can hide cards without touching selection state; bulk delete
   * must not reach them. */
  test("drops ids a filter change hid", () => {
    expect(visibleSelection(new Set(["a", "hidden"]), visible)).toEqual(
      new Set(["a"]),
    );
    expect(visibleSelection(new Set(["hidden"]), visible)).toEqual(new Set());
  });

  test("an empty board selects nothing", () => {
    expect(visibleSelection(new Set(["a"]), [])).toEqual(new Set());
  });
});
