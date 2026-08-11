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

describe("taskMatchesFilters — tag", () => {
  const tag = (id: string, name: string) => ({
    id,
    name,
    color: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
  });

  test("keeps a task carrying the filtered tag among others", () => {
    expect(
      taskMatchesFilters(
        item({ tags: [tag("tag_report", "Report"), tag("tag_seo", "SEO")] }),
        { ...EMPTY_FILTERS, tagId: "tag_seo" },
      ),
    ).toBe(true);
  });

  test("drops a task with other tags, or none at all", () => {
    expect(
      taskMatchesFilters(item({ tags: [tag("tag_report", "Report")] }), {
        ...EMPTY_FILTERS,
        tagId: "tag_seo",
      }),
    ).toBe(false);
    expect(
      taskMatchesFilters(item({ tags: [] }), {
        ...EMPTY_FILTERS,
        tagId: "tag_seo",
      }),
    ).toBe(false);
  });
});

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
