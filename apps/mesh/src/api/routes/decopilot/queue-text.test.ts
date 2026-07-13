import { describe, expect, test } from "bun:test";
import { type QueuePartRow, foldQueueHydration } from "./queue-text";

describe("foldQueueHydration", () => {
  test("concatenates text parts per message in seq order, even when interleaved", () => {
    const rows: QueuePartRow[] = [
      { message_id: "m1", kind: "text", seq: 0, payload: { text: "Hel" } },
      { message_id: "m2", kind: "text", seq: 0, payload: { text: "Foo" } },
      { message_id: "m1", kind: "text", seq: 2, payload: { text: "lo" } },
      { message_id: "m2", kind: "text", seq: 1, payload: { text: "bar" } },
      { message_id: "m1", kind: "text", seq: 1, payload: { text: " " } },
    ];

    const hydration = foldQueueHydration(rows);

    expect(hydration.get("m1")).toEqual({
      text: "Hel lo",
      hasAttachments: false,
    });
    expect(hydration.get("m2")).toEqual({
      text: "Foobar",
      hasAttachments: false,
    });
  });

  test("a file part flips hasAttachments without contributing text", () => {
    const rows: QueuePartRow[] = [
      { message_id: "m1", kind: "text", seq: 0, payload: { text: "hi" } },
      { message_id: "m1", kind: "file", seq: 1, payload: { url: "s3://x" } },
    ];

    const hydration = foldQueueHydration(rows);

    expect(hydration.get("m1")).toEqual({ text: "hi", hasAttachments: true });
  });

  test("unknown/malformed payload shapes contribute empty text and never throw", () => {
    const rows: QueuePartRow[] = [
      { message_id: "m1", kind: "text", seq: 0, payload: null },
      { message_id: "m1", kind: "text", seq: 1, payload: { text: 42 } },
      { message_id: "m1", kind: "text", seq: 2, payload: "not-an-object" },
      { message_id: "m1", kind: "finish", seq: 3, payload: {} },
    ];

    expect(() => foldQueueHydration(rows)).not.toThrow();
    const hydration = foldQueueHydration(rows);

    expect(hydration.get("m1")).toEqual({ text: "", hasAttachments: false });
  });

  test("empty rows produce an empty map", () => {
    expect(foldQueueHydration([])).toEqual(new Map());
  });
});
