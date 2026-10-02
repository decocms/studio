import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildProjectIndex, NO_PROJECT_FILTER } from "@/lib/project-index";
import { SUPER_AGENT_ASSIGNEE_ID, type TaskBoardItem } from "./config";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import {
  groupLevels,
  LIST_STATUS_ORDER,
  groupListItems,
  isGroupBy,
  isGroupOpen,
  toggleGroupOpen,
  type ListGroup,
  NO_TAG_GROUP,
  type GroupContext,
} from "./list-groups";
import { UNASSIGNED_FILTER } from "./task-filters-core";

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

const CONTEXT: GroupContext = {
  memberIds: ["user-a", "user-b"],
  tagIds: ["tag-x", "tag-y"],
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

const tag = (id: string) =>
  ({ id, name: id, color: null }) as TaskBoardItem["tags"][number];

const shape = (groups: ReturnType<typeof groupListItems>) =>
  groups.map((group) => [group.key, group.items.map((i) => i.id)]);

describe("groupListItems", () => {
  test("an empty list has no sections", () => {
    expect(groupListItems([], ["status"], CONTEXT)).toEqual([]);
  });

  test("status sections read from review down to done and keep item order", () => {
    const items = [
      item("1", { status: "done" }),
      item("2", { status: "todo" }),
      item("3", { status: "done" }),
      item("4", { status: "triage" }),
      item("5", { status: "in_progress" }),
      item("6", { status: "in_review" }),
    ];
    expect(shape(groupListItems(items, ["status"], CONTEXT))).toEqual([
      ["in_review", ["6"]],
      ["in_progress", ["5"]],
      ["todo", ["2"]],
      ["triage", ["4"]],
      ["done", ["1", "3"]],
    ]);
  });

  test("every board lane has a place in the list order", () => {
    expect([...LIST_STATUS_ORDER].sort()).toEqual(
      [...CANONICAL_COLUMN_KEYS].sort(),
    );
  });

  test("archived closes the status sections", () => {
    const items = [
      item("1", { status: "archived" }),
      item("2", { status: "in_review" }),
    ];
    expect(shape(groupListItems(items, ["status"], CONTEXT))).toEqual([
      ["in_review", ["2"]],
      ["archived", ["1"]],
    ]);
  });

  test("priority reads from urgent down to none", () => {
    const items = [
      item("1", { priority: "none" }),
      item("2", { priority: "low" }),
      item("3", { priority: "urgent" }),
      item("4", { priority: "medium" }),
    ];
    expect(shape(groupListItems(items, ["priority"], CONTEXT))).toEqual([
      ["urgent", ["3"]],
      ["medium", ["4"]],
      ["low", ["2"]],
      ["none", ["1"]],
    ]);
  });

  test("assignee: Super Agent, members in order, strangers, then unassigned", () => {
    const items = [
      item("1"),
      item("2", { assigneeId: "user-b" }),
      item("3", { assigneeId: "departed" }),
      item("4", { assigneeId: SUPER_AGENT_ASSIGNEE_ID }),
      item("5", { assigneeId: "user-a" }),
    ];
    expect(shape(groupListItems(items, ["assignee"], CONTEXT))).toEqual([
      [SUPER_AGENT_ASSIGNEE_ID, ["4"]],
      ["user-a", ["5"]],
      ["user-b", ["2"]],
      ["departed", ["3"]],
      [UNASSIGNED_FILTER, ["1"]],
    ]);
  });

  test("a task with several tags is listed under each; untagged comes last", () => {
    const items = [
      item("1"),
      item("2", { tags: [tag("tag-y"), tag("tag-x")] }),
      item("3", { tags: [tag("tag-y")] }),
    ];
    expect(shape(groupListItems(items, ["tags"], CONTEXT))).toEqual([
      ["tag-x", ["2"]],
      ["tag-y", ["2", "3"]],
      [NO_TAG_GROUP, ["1"]],
    ]);
  });

  test("project sections use the index's buckets; no project comes last", () => {
    const items = [
      item("1"),
      item("2", { repo: "acme/other" }),
      item("3", { repo: "ACME/Site" }),
    ];
    expect(shape(groupListItems(items, ["project"], CONTEXT))).toEqual([
      ["acme/site", ["3"]],
      ["acme/other", ["2"]],
      [NO_PROJECT_FILTER, ["1"]],
    ]);
  });
});

describe("nested grouping", () => {
  const items = [
    item("1", { assigneeId: "user-a", status: "done" }),
    item("2", { assigneeId: "user-b", status: "todo" }),
    item("3", { assigneeId: "user-a", status: "todo" }),
    item("4", { assigneeId: "user-a", status: "done" }),
  ];

  test("each group holds its own sub-groups, counted by what they hold", () => {
    const groups = groupListItems(items, ["assignee", "status"], CONTEXT);
    expect(
      groups.map((group) => [
        group.key,
        group.items.length,
        group.children?.map((child) => [
          child.key,
          child.items.map((i) => i.id),
        ]),
      ]),
    ).toEqual([
      [
        "user-a",
        3,
        [
          ["todo", ["3"]],
          ["done", ["1", "4"]],
        ],
      ],
      ["user-b", 1, [["todo", ["2"]]]],
    ]);
  });

  test("paths are unique across levels and name the criterion", () => {
    const groups = groupListItems(items, ["assignee", "status"], CONTEXT);
    const paths = groups.flatMap((group) => [
      group.path,
      ...(group.children ?? []).map((child) => child.path),
    ]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(groups[0]?.children?.[0]?.path).toBe("/assignee:user-a/status:todo");
  });

  test("a single level has no children", () => {
    const [group] = groupListItems(items, ["status"], CONTEXT);
    expect(group?.children).toBeNull();
  });
});

describe("groupLevels", () => {
  test("no group means no levels, even with a sub-group", () => {
    expect(groupLevels(null, "status")).toEqual([]);
  });

  test("a sub-group equal to the group is dropped", () => {
    expect(groupLevels("status", "status")).toEqual(["status"]);
  });

  test("a distinct sub-group nests under the group", () => {
    expect(groupLevels("assignee", "status")).toEqual(["assignee", "status"]);
  });
});

describe("isGroupBy", () => {
  test("accepts the offered criteria and rejects anything else", () => {
    expect(isGroupBy("tags")).toBe(true);
    expect(isGroupBy("due")).toBe(false);
    expect(isGroupBy(undefined)).toBe(false);
  });
});

describe("group open state", () => {
  const items = [
    item("1", { status: "todo" }),
    item("2", { status: "archived" }),
    item("3", { status: "done" }),
  ];
  const groups = groupListItems(items, ["status"], CONTEXT);
  const [todo, done, archived] = groups as [ListGroup, ListGroup, ListGroup];

  test("archived starts collapsed; every other lane starts open", () => {
    expect(groups.map((g) => [g.key, isGroupOpen(g, new Map())])).toEqual([
      ["todo", true],
      ["done", true],
      ["archived", false],
    ]);
  });

  test("a click flips only the clicked group, from its default", () => {
    const opened = toggleGroupOpen(new Map(), archived, groups, false);
    expect(isGroupOpen(archived, opened)).toBe(true);
    expect(isGroupOpen(todo, opened)).toBe(true);
    const closed = toggleGroupOpen(opened, archived, groups, false);
    expect(isGroupOpen(archived, closed)).toBe(false);
  });

  test("Alt+click moves every sibling to the clicked group's new state", () => {
    const allClosed = toggleGroupOpen(new Map(), todo, groups, true);
    expect(groups.map((g) => isGroupOpen(g, allClosed))).toEqual([
      false,
      false,
      false,
    ]);
    const allOpen = toggleGroupOpen(allClosed, done, groups, true);
    expect(groups.map((g) => isGroupOpen(g, allOpen))).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("only a status section collapses by default", () => {
    const [byAssignee] = groupListItems(
      [item("1", { status: "archived" })],
      ["assignee"],
      CONTEXT,
    );
    expect(byAssignee?.collapsedByDefault).toBe(false);
  });
});
