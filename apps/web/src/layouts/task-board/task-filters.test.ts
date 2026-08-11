import { describe, expect, test } from "bun:test";
import { taskMatchesFilters, EMPTY_FILTERS } from "./task-filters";
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
