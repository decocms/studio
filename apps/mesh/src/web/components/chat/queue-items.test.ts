import { describe, expect, it } from "bun:test";
import {
  dropQueueItem,
  selectQueuedItems,
  upsertQueueItem,
  type QueueItemDTO,
} from "./queue-items";

const item = (
  id: string,
  status: "running" | "queued",
  enqueuedAt: number,
): QueueItemDTO => ({
  workflowId: `thread-run:t:${id}`,
  messageId: id,
  status,
  enqueuedAt,
});

describe("selectQueuedItems", () => {
  it("returns nothing for an empty queue", () => {
    expect(selectQueuedItems([])).toEqual([]);
  });

  it("excludes the running head — it's already shown in the body", () => {
    expect(selectQueuedItems([item("head", "running", 1)])).toEqual([]);
  });

  it("returns [] when every item is running", () => {
    const out = selectQueuedItems([
      item("a", "running", 1),
      item("b", "running", 2),
    ]);
    expect(out).toEqual([]);
  });

  it("returns only the queued items, sorted by enqueuedAt", () => {
    const out = selectQueuedItems([
      item("q2", "queued", 3),
      item("head", "running", 1),
      item("q1", "queued", 2),
    ]);
    expect(out.map((i) => i.messageId)).toEqual(["q1", "q2"]);
  });
});

describe("upsertQueueItem", () => {
  it("appends a new item", () => {
    const out = upsertQueueItem(
      [item("a", "queued", 1)],
      item("b", "queued", 2),
    );
    expect(out.map((i) => i.messageId)).toEqual(["a", "b"]);
  });

  it("is idempotent by messageId (no duplicate when re-enqueued)", () => {
    const out = upsertQueueItem(
      [item("a", "queued", 1)],
      item("a", "queued", 9),
    );
    expect(out.map((i) => i.messageId)).toEqual(["a"]);
  });
});

describe("dropQueueItem", () => {
  it("removes the matching messageId", () => {
    const out = dropQueueItem(
      [item("a", "queued", 1), item("b", "queued", 2)],
      "a",
    );
    expect(out.map((i) => i.messageId)).toEqual(["b"]);
  });

  it("is a no-op when the id is absent", () => {
    const out = dropQueueItem([item("a", "queued", 1)], "zzz");
    expect(out.map((i) => i.messageId)).toEqual(["a"]);
  });
});
