import { describe, expect, test } from "bun:test";
import { findTaskByKeyOrId } from "./resolve";

const items = [
  { id: "board_abc", keySeq: 1 },
  { id: "board_def", keySeq: 12 },
  { id: "board_ghi", keySeq: null },
];

describe("findTaskByKeyOrId", () => {
  test("resolves the full key, in any case or padding", () => {
    expect(findTaskByKeyOrId(items, "DECO-01")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "deco-1")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "12")?.id).toBe("board_def");
  });

  test("resolves a raw id — what a keyless card's share link carries", () => {
    expect(findTaskByKeyOrId(items, "board_ghi")?.id).toBe("board_ghi");
  });

  test("misses cleanly", () => {
    expect(findTaskByKeyOrId(items, "DECO-99")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "board_nope")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "")).toBeUndefined();
    expect(findTaskByKeyOrId(items, undefined)).toBeUndefined();
  });
});
