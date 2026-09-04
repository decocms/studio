import { describe, expect, test } from "bun:test";
import { DebouncedSaveQueue } from "./debounced-save-queue";

describe("DebouncedSaveQueue", () => {
  test("flushes the latest pending value on unmount by default", () => {
    const consumed: string[] = [];
    const queue = new DebouncedSaveQueue<string>((value) => {
      consumed.push(value);
    });

    queue.schedule("page", "first", 60_000);
    queue.schedule("page", "latest", 60_000);
    queue.settleOnUnmount();

    expect(consumed).toEqual(["latest"]);
  });

  test("flushes every independently keyed edit exactly once", () => {
    const consumed: string[] = [];
    const queue = new DebouncedSaveQueue<string>((value) => {
      consumed.push(value);
    });

    queue.schedule("page", "page edit", 60_000);
    queue.schedule("section", "section edit", 60_000);
    queue.flush();
    queue.settleOnUnmount();

    expect(consumed).toEqual(["page edit", "section edit"]);
  });

  test("supports an explicit discard before unmount", () => {
    const consumed: string[] = [];
    const queue = new DebouncedSaveQueue<string>((value) => {
      consumed.push(value);
    });

    queue.schedule("cancelled-sheet", "draft", 60_000);
    queue.discard();
    queue.settleOnUnmount();

    expect(consumed).toEqual([]);
  });

  test("attempts every pending save even if one consumer throws", () => {
    const consumed: string[] = [];
    const queue = new DebouncedSaveQueue<string>((value) => {
      consumed.push(value);
      if (value === "broken") throw new Error("invalid builder");
    });

    queue.schedule("first", "broken", 60_000);
    queue.schedule("second", "valid", 60_000);

    expect(() => queue.flush()).toThrow("invalid builder");
    expect(consumed).toEqual(["broken", "valid"]);
    expect(() => queue.settleOnUnmount()).not.toThrow();
  });
});
