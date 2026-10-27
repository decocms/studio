import { describe, expect, test } from "bun:test";
import type { TaskBoardItem } from "./config";
import {
  childrenOf,
  epicStatus,
  isSubtask,
  laneCards,
  progressOf,
} from "./epics";

const card = (
  id: string,
  status: TaskBoardItem["status"] = "todo",
  patch: Partial<TaskBoardItem> = {},
) =>
  ({
    id,
    status,
    parentId: null,
    isEpic: false,
    threads: [],
    ...patch,
  }) as unknown as TaskBoardItem;

describe("progressOf", () => {
  test("splits children into done, in flight and not started", () => {
    expect(
      progressOf([
        card("1", "done"),
        card("2", "in_review"),
        card("3", "triage"),
        card("4", "todo"),
      ]),
    ).toEqual({ done: 1, active: 1, todo: 2, total: 4 });
  });

  test("leaves archived children out of the total", () => {
    expect(progressOf([card("1", "done"), card("2", "archived")])).toEqual({
      done: 1,
      active: 0,
      todo: 0,
      total: 1,
    });
  });

  test("is empty with no children", () => {
    expect(progressOf([]).total).toBe(0);
  });
});

describe("laneCards", () => {
  const items = [
    card("epic", "todo", { isEpic: true }),
    card("a", "in_progress", { parentId: "epic" }),
    card("b", "todo", { parentId: "epic" }),
    card("sub", "todo", { parentId: "a" }),
    card("loose", "qa"),
  ];

  test("keeps subtasks inside their parent", () => {
    expect(laneCards(items, items).map((i) => i.id)).toEqual([
      "epic",
      "a",
      "b",
      "loose",
    ]);
  });

  test("puts an epic in the lane its cards add up to", () => {
    const epic = laneCards(items, items).find((i) => i.id === "epic");
    expect(epic?.status).toBe("in_progress");
  });

  test("leaves an archived epic archived", () => {
    const archived = [card("epic", "archived", { isEpic: true }), items[1]!];
    expect(laneCards(archived, archived)[0]?.status).toBe("archived");
  });

  test("leaves every other card where it was saved", () => {
    const loose = laneCards(items, items).find((i) => i.id === "loose");
    expect(loose?.status).toBe("qa");
  });

  test("shows a subtask whose parent is gone", () => {
    const orphan = card("orphan", "todo", { parentId: "deleted" });
    expect(laneCards([orphan], [orphan]).map((i) => i.id)).toEqual(["orphan"]);
  });

  test("shows a subtask that waits on a person or failed", () => {
    const parent = card("parent", "in_progress");
    const blocked = card("blocked", "in_progress", {
      parentId: "parent",
      threads: [{ status: "requires_action" }] as TaskBoardItem["threads"],
    });
    const settled = card("settled", "done", {
      parentId: "parent",
      threads: [{ status: "requires_action" }] as TaskBoardItem["threads"],
    });
    const all = [parent, blocked, settled];
    expect(laneCards(all, all).map((i) => i.id)).toEqual(["parent", "blocked"]);
  });
});

describe("childrenOf", () => {
  test("returns only direct children", () => {
    const items = [
      card("epic", "todo", { isEpic: true }),
      card("a", "todo", { parentId: "epic" }),
      card("b", "todo", { parentId: "epic" }),
      card("sub", "todo", { parentId: "a" }),
    ];
    expect(childrenOf(items, "epic").map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("isSubtask", () => {
  const items = [
    card("epic", "todo", { isEpic: true }),
    card("a", "todo", { parentId: "epic" }),
    card("sub", "todo", { parentId: "a" }),
  ];

  test("is a card under another card", () => {
    expect(isSubtask(items, items[2]!)).toBe(true);
  });

  test("is not a card under an epic, or at the top level", () => {
    expect(isSubtask(items, items[1]!)).toBe(false);
    expect(isSubtask(items, items[0]!)).toBe(false);
  });
});

describe("epicStatus", () => {
  const progress = (done: number, active: number, todo: number) => ({
    done,
    active,
    todo,
    total: done + active + todo,
  });

  test("is done only when every card is", () => {
    expect(epicStatus(progress(3, 0, 0))).toBe("done");
    expect(epicStatus(progress(2, 0, 1))).toBe("in_progress");
  });

  test("is in progress once any card started", () => {
    expect(epicStatus(progress(0, 1, 2))).toBe("in_progress");
  });

  test("is to do with nothing started, or no cards", () => {
    expect(epicStatus(progress(0, 0, 2))).toBe("todo");
    expect(epicStatus(progress(0, 0, 0))).toBe("todo");
  });
});
