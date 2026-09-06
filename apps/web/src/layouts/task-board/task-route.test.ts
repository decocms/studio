import { describe, expect, test } from "bun:test";
import { findTaskByKeyOrId, taskRouteSegment } from "./task-route";

const items = [
  { id: "board_abc", keySeq: 1 },
  { id: "board_def", keySeq: 12 },
  { id: "board_ghi", keySeq: null },
  { id: "board_jkl", keySeq: 333 },
];

describe("taskRouteSegment", () => {
  test("writes the canonical key the card already shows", () => {
    expect(taskRouteSegment("deco", items[0]!)).toBe("DECO-01");
    expect(taskRouteSegment("deco", items[1]!)).toBe("DECO-12");
  });

  test("falls back to the id when the card has no key", () => {
    expect(taskRouteSegment("deco", items[2]!)).toBe("board_ghi");
  });

  /** The contract the two halves of this module exist to keep: what a link
   *  writes is what the board reads back. */
  test("round-trips through findTaskByKeyOrId", () => {
    for (const item of items) {
      expect(findTaskByKeyOrId(items, taskRouteSegment("deco", item))?.id).toBe(
        item.id,
      );
    }
  });
});

describe("findTaskByKeyOrId", () => {
  test("resolves the full key, in any case or padding", () => {
    expect(findTaskByKeyOrId(items, "DECO-01")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "deco-1")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "12")?.id).toBe("board_def");
  });

  test("resolves a raw id — what a keyless card's link carries", () => {
    expect(findTaskByKeyOrId(items, "board_ghi")?.id).toBe("board_ghi");
  });

  test("misses cleanly", () => {
    expect(findTaskByKeyOrId(items, "DECO-99")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "board_nope")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "")).toBeUndefined();
    expect(findTaskByKeyOrId(items, undefined)).toBeUndefined();
  });
});
