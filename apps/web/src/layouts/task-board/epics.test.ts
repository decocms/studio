import { describe, expect, test } from "bun:test";
import type { TaskBoardItem } from "./config";
import { childrenOf, epicStatus, laneCards, progressOf } from "./epics";

const card = (id: string, status: TaskBoardItem["status"] = "todo") =>
  ({ id, status }) as TaskBoardItem;

const hierarchy = {
  epics: ["epic"],
  parents: { a: "epic", b: "epic", sub: "a" },
};

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
    card("epic", "todo"),
    card("a", "in_progress"),
    card("b", "todo"),
    card("sub", "todo"),
    card("loose", "qa"),
  ];

  test("keeps subtasks inside their parent", () => {
    expect(laneCards(hierarchy, items, items).map((i) => i.id)).toEqual([
      "epic",
      "a",
      "b",
      "loose",
    ]);
  });

  test("puts an epic in the lane its cards add up to", () => {
    const epic = laneCards(hierarchy, items, items).find(
      (i) => i.id === "epic",
    );
    expect(epic?.status).toBe("in_progress");
  });

  test("leaves every other card where it was saved", () => {
    const loose = laneCards(hierarchy, items, items).find(
      (i) => i.id === "loose",
    );
    expect(loose?.status).toBe("qa");
  });
});

describe("childrenOf", () => {
  test("returns only direct children", () => {
    const items = ["epic", "a", "b", "sub", "loose"].map((id) => card(id));
    expect(childrenOf(hierarchy, items, "epic").map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
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
