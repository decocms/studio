import { describe, expect, test } from "bun:test";
import { buildProjectIndex, NO_PROJECT_FILTER } from "@/lib/project-index";
import { activeFilterFieldIds, withFieldCleared } from "./filter-fields";
import { BACKLOG_SPRINT_FILTER } from "./task-filters-core";
/** Type-only: the board's filter module is a component file, and pulling it in
 *  at runtime would drag the whole UI tree into a pure test. */
import type { TaskFilters } from "./task-filters-core";

const EMPTY_FILTERS: TaskFilters = {
  assignee: null,
  priority: null,
  due: null,
  tags: [],
  project: null,
  sprint: null,
  search: "",
};

const EMPTY_INDEX = buildProjectIndex([]);
const SITE_INDEX = buildProjectIndex([], ["acme/site"]);

describe("activeFilterFieldIds", () => {
  test("no filters set means no chips", () => {
    expect(activeFilterFieldIds(EMPTY_FILTERS, EMPTY_INDEX, null)).toEqual([]);
  });

  test("free-text search is not a chip — it has its own control", () => {
    expect(
      activeFilterFieldIds(
        { ...EMPTY_FILTERS, search: "login" },
        EMPTY_INDEX,
        null,
      ),
    ).toEqual([]);
  });

  test("listed in the menu's order, not the order they were set", () => {
    expect(
      activeFilterFieldIds(
        { ...EMPTY_FILTERS, tags: ["t1"], priority: "high" },
        EMPTY_INDEX,
        null,
      ),
    ).toEqual(["priority", "tags"]);
  });

  test("an empty tag list is not active", () => {
    expect(
      activeFilterFieldIds({ ...EMPTY_FILTERS, tags: [] }, EMPTY_INDEX, null),
    ).toEqual([]);
  });

  /** A project id the index cannot resolve lets every card through, so a chip
   *  for it would claim a narrowing the board is not doing. */
  test("a project filter that narrows nothing gets no chip", () => {
    expect(
      activeFilterFieldIds(
        { ...EMPTY_FILTERS, project: "vir_gone" },
        EMPTY_INDEX,
        null,
      ),
    ).toEqual([]);
  });

  test("a resolvable project bucket does get a chip", () => {
    expect(
      activeFilterFieldIds(
        { ...EMPTY_FILTERS, project: "acme/site" },
        SITE_INDEX,
        null,
      ),
    ).toEqual(["project"]);
  });

  test("the no-project bucket narrows, so it gets a chip", () => {
    expect(
      activeFilterFieldIds(
        { ...EMPTY_FILTERS, project: NO_PROJECT_FILTER },
        EMPTY_INDEX,
        null,
      ),
    ).toEqual(["project"]);
  });
});

describe("withFieldCleared", () => {
  test("clears only the named field", () => {
    const filters = {
      ...EMPTY_FILTERS,
      assignee: "u1",
      priority: "high" as const,
      tags: ["t1"],
      search: "login",
    };

    expect(withFieldCleared(filters, "priority", null)).toEqual({
      ...filters,
      priority: null,
    });
    expect(withFieldCleared(filters, "tags", null)).toEqual({
      ...filters,
      tags: [],
    });
  });

  test("leaves the free-text search alone", () => {
    expect(
      withFieldCleared({ ...EMPTY_FILTERS, search: "login" }, "assignee", null)
        .search,
    ).toBe("login");
  });
});

describe("the sprint chip", () => {
  const withSprint = (sprint: string | null) => ({ ...EMPTY_FILTERS, sprint });

  test("the running sprint is the board's scope, not a chip", () => {
    expect(
      activeFilterFieldIds(withSprint("sprint_now"), EMPTY_INDEX, "sprint_now"),
    ).toEqual([]);
  });

  test("another sprint, or the backlog, narrows the board", () => {
    expect(
      activeFilterFieldIds(withSprint("sprint_old"), EMPTY_INDEX, "sprint_now"),
    ).toEqual(["sprint"]);
    expect(
      activeFilterFieldIds(
        withSprint(BACKLOG_SPRINT_FILTER),
        EMPTY_INDEX,
        "sprint_now",
      ),
    ).toEqual(["sprint"]);
  });

  test("with nothing running, any sprint is a chip", () => {
    expect(
      activeFilterFieldIds(withSprint("sprint_old"), EMPTY_INDEX, null),
    ).toEqual(["sprint"]);
  });

  test("clearing it goes back to the running sprint", () => {
    expect(
      withFieldCleared(withSprint("sprint_old"), "sprint", "sprint_now").sprint,
    ).toBe("sprint_now");
    expect(
      withFieldCleared(withSprint(BACKLOG_SPRINT_FILTER), "sprint", null)
        .sprint,
    ).toBeNull();
  });
});
