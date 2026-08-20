import { describe, expect, test } from "bun:test";
import {
  matchesTaskKey,
  taskMatchesFilters,
  EMPTY_FILTERS,
} from "./task-filters";
import type { TaskBoardItem } from "./config";

function item(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: "item-1",
    organizationId: "org-1",
    title: "Task",
    description: null,
    status: "todo",
    priority: "none",
    assigneeId: null,
    assignedBy: null,
    dueDate: null,
    threads: [],
    tags: [],
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedBy: "user-1",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskBoardItem;
}

describe("taskMatchesFilters — due date", () => {
  test("'week' excludes a task that is already overdue", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: yesterday }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
    ).toBe(false);
  });

  test("'week' includes a task due within the next 7 days", () => {
    const in3Days = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: in3Days }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
    ).toBe(true);
  });

  test("'week' excludes a task due more than 7 days out", () => {
    const in10Days = new Date(
      Date.now() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: in10Days }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — tags", () => {
  const tag = (id: string) => ({
    id,
    name: id,
    color: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
  });

  test("includes a task that has one of the selected tags", () => {
    expect(
      taskMatchesFilters(item({ tags: [tag("a"), tag("b")] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(true);
  });

  test("excludes a task that has none of the selected tags", () => {
    expect(
      taskMatchesFilters(item({ tags: [tag("a")] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(false);
  });

  test("excludes a task with no tags when a tag filter is active", () => {
    expect(
      taskMatchesFilters(item({ tags: [] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — search", () => {
  test("empty search lets every task through", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix login bug" }), EMPTY_FILTERS),
    ).toBe(true);
  });

  test("matches a title case-insensitively", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix Login Bug" }), {
        ...EMPTY_FILTERS,
        search: "login",
      }),
    ).toBe(true);
  });

  test("matches a description when the title doesn't match", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Task", description: "Related to onboarding flow" }),
        { ...EMPTY_FILTERS, search: "onboarding" },
      ),
    ).toBe(true);
  });

  test("excludes a task matching neither title nor description", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix login bug" }), {
        ...EMPTY_FILTERS,
        search: "billing",
      }),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — repo", () => {
  // NO_REPO_FILTER is module-private; assert against its raw sentinel value.
  const NO_REPO = "__no_repo__";

  test("no repo filter lets every task through", () => {
    expect(taskMatchesFilters(item({ repo: "acme/site" }), EMPTY_FILTERS)).toBe(
      true,
    );
    expect(taskMatchesFilters(item({ repo: null }), EMPTY_FILTERS)).toBe(true);
  });

  test("a specific repo matches the same repo", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/site" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(true);
  });

  test("a specific repo excludes a different repo", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/other" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(false);
  });

  test("a specific repo excludes a task with no repo", () => {
    expect(
      taskMatchesFilters(item({ repo: null }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(false);
  });

  test("repo match is case-insensitive (GitHub identity)", () => {
    expect(
      taskMatchesFilters(item({ repo: "Acme/Site" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(true);
  });

  test("'no repo' matches a task with no repo", () => {
    expect(
      taskMatchesFilters(item({ repo: null }), {
        ...EMPTY_FILTERS,
        repo: NO_REPO,
      }),
    ).toBe(true);
  });

  test("'no repo' excludes a repo-backed task", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/site" }), {
        ...EMPTY_FILTERS,
        repo: NO_REPO,
      }),
    ).toBe(false);
  });
});

describe("matchesTaskKey", () => {
  test("matches the bare number, padded or not", () => {
    expect(matchesTaskKey("7", 7)).toBe(true);
    expect(matchesTaskKey("07", 7)).toBe(true);
  });

  test("matches the whole key, in any case", () => {
    expect(matchesTaskKey("DECO-07", 7)).toBe(true);
    expect(matchesTaskKey("deco-7", 7)).toBe(true);
  });

  test("does not match another card's number", () => {
    expect(matchesTaskKey("8", 7)).toBe(false);
    expect(matchesTaskKey("70", 7)).toBe(false);
  });

  test("ordinary words are not keys", () => {
    expect(matchesTaskKey("carrossel", 7)).toBe(false);
    expect(matchesTaskKey("", 7)).toBe(false);
  });

  test("a card from before the backfill never matches", () => {
    expect(matchesTaskKey("7", null)).toBe(false);
  });
});
