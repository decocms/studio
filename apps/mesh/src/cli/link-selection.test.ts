import { describe, expect, it } from "bun:test";
import {
  nextSelection,
  orderedHandles,
  selectionAfterRemoval,
} from "./link-selection";

describe("orderedHandles", () => {
  it("sorts handles the way the table renders them", () => {
    const m = new Map([
      ["c", { handle: "c" }],
      ["a", { handle: "a" }],
      ["b", { handle: "b" }],
    ]);
    expect(orderedHandles(m)).toEqual(["a", "b", "c"]);
  });
});

describe("nextSelection", () => {
  const h = ["a", "b", "c"];
  it("moves down and up", () => {
    expect(nextSelection(h, "a", 1)).toBe("b");
    expect(nextSelection(h, "b", -1)).toBe("a");
  });
  it("clamps at the ends", () => {
    expect(nextSelection(h, "c", 1)).toBe("c");
    expect(nextSelection(h, "a", -1)).toBe("a");
  });
  it("seeds from an edge when nothing is selected", () => {
    expect(nextSelection(h, null, 1)).toBe("a");
    expect(nextSelection(h, null, -1)).toBe("c");
  });
  it("returns null for an empty list", () => {
    expect(nextSelection([], null, 1)).toBeNull();
  });
});

describe("selectionAfterRemoval", () => {
  const h = ["a", "b", "c"];
  it("keeps the current selection when a different row is removed", () => {
    expect(selectionAfterRemoval(h, "c", "a")).toBe("a");
  });
  it("moves to the next row when the selected row is removed", () => {
    expect(selectionAfterRemoval(h, "b", "b")).toBe("c");
  });
  it("falls back to the previous row when removing the last", () => {
    expect(selectionAfterRemoval(h, "c", "c")).toBe("b");
  });
  it("returns null when the only row is removed", () => {
    expect(selectionAfterRemoval(["a"], "a", "a")).toBeNull();
  });
});
