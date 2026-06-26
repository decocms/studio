import { describe, expect, it } from "bun:test";
import {
  dropQueueItem,
  selectWaitingQueueItems,
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
  text: id,
  status,
  enqueuedAt,
});

describe("selectWaitingQueueItems", () => {
  it("returns nothing for an empty queue", () => {
    expect(selectWaitingQueueItems([])).toEqual([]);
  });

  it("hides a lone PENDING head (running, in the body)", () => {
    expect(selectWaitingQueueItems([item("a", "running", 1)])).toEqual([]);
  });

  it("hides a lone ENQUEUED head — the 'accepted and queued' window", () => {
    // The reported bug: a just-sent first message sits ENQUEUED before it
    // flips to PENDING; it's the active run shown in the body, not a wait.
    expect(selectWaitingQueueItems([item("massa", "queued", 1)])).toEqual([]);
  });

  it("shows the messages waiting behind a running head", () => {
    const out = selectWaitingQueueItems([
      item("head", "running", 1),
      item("q1", "queued", 2),
      item("q2", "queued", 3),
    ]);
    expect(out.map((i) => i.messageId)).toEqual(["q1", "q2"]);
  });

  it("drops the oldest when none is running yet (all ENQUEUED)", () => {
    const out = selectWaitingQueueItems([
      item("head", "queued", 1),
      item("q1", "queued", 2),
    ]);
    expect(out.map((i) => i.messageId)).toEqual(["q1"]);
  });

  it("sorts by enqueuedAt before dropping the head", () => {
    const out = selectWaitingQueueItems([
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
