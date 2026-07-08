import { describe, expect, it } from "bun:test";
import {
  dropQueueItem,
  selectHiddenFromBody,
  selectQueuedItems,
  textFromParts,
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
  text: `text-${id}`,
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

describe("selectHiddenFromBody", () => {
  it("returns an empty set for an empty queue", () => {
    expect(selectHiddenFromBody([])).toEqual(new Set());
  });

  it("excludes the running head — it's already shown in the body", () => {
    expect(selectHiddenFromBody([item("head", "running", 1)])).toEqual(
      new Set(),
    );
  });

  it("includes only queued messageIds", () => {
    const out = selectHiddenFromBody([
      item("head", "running", 1),
      item("q1", "queued", 2),
      item("q2", "queued", 3),
    ]);
    expect(out).toEqual(new Set(["q1", "q2"]));
  });
});

describe("textFromParts", () => {
  it("returns an empty string for undefined parts", () => {
    expect(textFromParts(undefined)).toBe("");
  });

  it("returns an empty string for no parts", () => {
    expect(textFromParts([])).toBe("");
  });

  it("concatenates multiple text parts", () => {
    expect(
      textFromParts([
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("skips non-text parts", () => {
    expect(
      textFromParts([
        { type: "text", text: "hello" },
        { type: "file", text: "ignored" },
        { type: "text", text: " there" },
      ]),
    ).toBe("hello there");
  });

  it("trims leading/trailing whitespace off the joined result", () => {
    expect(textFromParts([{ type: "text", text: "  padded  " }])).toBe(
      "padded",
    );
  });

  it("skips a text part whose text isn't a string", () => {
    expect(
      textFromParts([
        { type: "text", text: 42 as unknown as string },
        { type: "text", text: "ok" },
      ]),
    ).toBe("ok");
  });
});
