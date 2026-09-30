import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildProjectIndex } from "@/lib/project-index";
import { SUPER_AGENT_ASSIGNEE_ID, type TaskBoardItem } from "./config";
import {
  defaultSortDirection,
  isSortBy,
  sortListItems,
  type SortContext,
} from "./list-sort";

const SITE = {
  id: "vir_site",
  title: "Acme Site",
  created_at: "2026-01-01T00:00:00Z",
  metadata: {
    repository: {
      url: "https://github.com/acme/site",
      owner: "acme",
      name: "site",
    },
  },
} as unknown as VirtualMCPEntity;

const CONTEXT: SortContext = {
  memberNames: new Map([
    ["user-a", "Ana"],
    ["user-b", "bruno"],
  ]),
  superAgentName: "Super Agent",
  index: buildProjectIndex([SITE], ["acme/other"]),
};

function item(
  id: string,
  overrides: Partial<TaskBoardItem> = {},
): TaskBoardItem {
  return {
    id,
    organizationId: "org-1",
    title: id,
    description: null,
    status: "todo",
    priority: "none",
    assigneeId: null,
    assignedBy: null,
    dueDate: null,
    threads: [],
    tags: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-1",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskBoardItem;
}

const tag = (name: string) =>
  ({ id: name, name, color: null }) as TaskBoardItem["tags"][number];

const ids = (items: TaskBoardItem[]) => items.map((i) => i.id);

describe("sortListItems", () => {
  test("priority reads most urgent first by default; none closes", () => {
    const items = [
      item("none"),
      item("low", { priority: "low" }),
      item("urgent", { priority: "urgent" }),
      item("medium", { priority: "medium" }),
    ];
    expect(defaultSortDirection("priority")).toBe("desc");
    expect(ids(sortListItems(items, "priority", "desc", CONTEXT))).toEqual([
      "urgent",
      "medium",
      "low",
      "none",
    ]);
    expect(ids(sortListItems(items, "priority", "asc", CONTEXT))).toEqual([
      "low",
      "medium",
      "urgent",
      "none",
    ]);
  });

  test("due date reads soonest first; tasks without one close either way", () => {
    const items = [
      item("none"),
      item("late", { dueDate: "2026-03-01T00:00:00Z" }),
      item("soon", { dueDate: "2026-02-01T00:00:00Z" }),
    ];
    expect(ids(sortListItems(items, "due", "asc", CONTEXT))).toEqual([
      "soon",
      "late",
      "none",
    ]);
    expect(ids(sortListItems(items, "due", "desc", CONTEXT))).toEqual([
      "late",
      "soon",
      "none",
    ]);
  });

  test("assignee sorts by display name, case-insensitively", () => {
    const items = [
      item("unassigned"),
      item("bruno", { assigneeId: "user-b" }),
      item("agent", { assigneeId: SUPER_AGENT_ASSIGNEE_ID }),
      item("ana", { assigneeId: "user-a" }),
    ];
    expect(ids(sortListItems(items, "assignee", "asc", CONTEXT))).toEqual([
      "ana",
      "bruno",
      "agent",
      "unassigned",
    ]);
  });

  test("tags sort by a task's alphabetically first tag", () => {
    const items = [
      item("untagged"),
      item("zeta", { tags: [tag("Zeta")] }),
      item("mixed", { tags: [tag("Zeta"), tag("Alpha")] }),
    ];
    expect(ids(sortListItems(items, "tags", "asc", CONTEXT))).toEqual([
      "mixed",
      "zeta",
      "untagged",
    ]);
  });

  test("project sorts by the index's title; no project closes", () => {
    const items = [
      item("none"),
      item("site", { repo: "acme/site" }),
      item("other", { repo: "acme/other" }),
    ];
    expect(ids(sortListItems(items, "project", "desc", CONTEXT))).toEqual([
      "other",
      "site",
      "none",
    ]);
  });

  test("ties keep their incoming order and the input is not mutated", () => {
    const items = [
      item("1", { priority: "high" }),
      item("2", { priority: "high" }),
      item("3", { priority: "high" }),
    ];
    expect(ids(sortListItems(items, "priority", "desc", CONTEXT))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(sortListItems([], "due", "asc", CONTEXT)).toEqual([]);
    expect(ids(items)).toEqual(["1", "2", "3"]);
  });
});

test("isSortBy rejects anything outside the options", () => {
  expect(isSortBy("due")).toBe(true);
  expect(isSortBy("status")).toBe(false);
  expect(isSortBy(undefined)).toBe(false);
});
