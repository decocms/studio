import { describe, expect, test } from "bun:test";
import { insertSortOrder, runSortOrders } from "./config";
import type { TaskBoardItem } from "./config";

function item(id: string, sortOrder: number): TaskBoardItem {
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
    sortOrder,
    threads: [],
    tags: [],
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedBy: "user-1",
    updatedAt: new Date().toISOString(),
  } as TaskBoardItem;
}

describe("insertSortOrder", () => {
  const lane = [item("a", 0), item("b", 10), item("c", 20)];

  test("lands between its two new neighbors", () => {
    // Drop "a" so it lands right before "c" (i.e. between "b" and "c").
    expect(insertSortOrder(lane, "c", "a")).toBe(15);
  });

  test("lands at the end when beforeId is null", () => {
    expect(insertSortOrder(lane, null, "a")).toBe(21);
  });

  test("lands at the start when there is no prev neighbor", () => {
    // Drop "c" so it lands right before "a" (i.e. at the very start).
    expect(insertSortOrder(lane, "a", "c")).toBe(-1);
  });

  test("hovering the dragged card's own row is a no-op, not a jump to the end", () => {
    // "b" is dragged and hovered over its own (upper-half) row, which reports
    // itself as beforeId. It must stay between "a" and "c", not jump last.
    expect(insertSortOrder(lane, "b", "b")).toBe(10);
  });

  test("hovering the last card's own row still resolves to the end", () => {
    expect(insertSortOrder(lane, "c", "c")).toBe(11);
  });
});

describe("runSortOrders", () => {
  test("a single card lands exactly on the drop slot", () => {
    expect(runSortOrders(10, 1)).toEqual([10]);
  });

  test("a dragged group keeps its order and ends at the drop slot", () => {
    const orders = runSortOrders(10, 3);
    // Ascending — lanes sort by sortOrder asc, so input order must survive the
    // round trip through the DB. Reversing the offset here reverses the group.
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(orders.at(-1)).toBe(10);
  });

  test("the whole run sits at or before the drop slot", () => {
    for (const order of runSortOrders(10, 5))
      expect(order).toBeLessThanOrEqual(10);
  });
});
