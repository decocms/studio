import { describe, expect, it } from "bun:test";
import {
  compactBoard,
  findFirstFreeSlot,
  insertTile,
  moveTile,
  removeTile,
  resizeTile,
  resolveCollisions,
} from "./grid-utils";
import type { TileInstance } from "./types";

function tile(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): TileInstance {
  return { id, type: "test", x, y, w, h };
}

describe("compactBoard", () => {
  it("floats a free-floating tile up to the top", () => {
    const out = compactBoard([tile("a", 0, 5, 1, 1)]);
    expect(out[0]!.y).toBe(0);
  });

  it("preserves stacking order top-to-bottom", () => {
    const out = compactBoard([tile("b", 0, 4, 1, 1), tile("a", 0, 1, 1, 1)]);
    const a = out.find((t) => t.id === "a")!;
    const b = out.find((t) => t.id === "b")!;
    expect(a.y).toBe(0);
    expect(b.y).toBe(1);
  });

  it("packs side-by-side tiles into the same row", () => {
    const out = compactBoard([tile("a", 0, 7, 1, 1), tile("b", 1, 9, 1, 1)]);
    expect(out.find((t) => t.id === "a")!.y).toBe(0);
    expect(out.find((t) => t.id === "b")!.y).toBe(0);
  });
});

describe("resolveCollisions", () => {
  it("pushes overlapping tiles down", () => {
    const others = [tile("a", 0, 0, 1, 1)];
    const pinned = tile("b", 0, 0, 1, 1);
    const out = resolveCollisions(pinned, others);
    expect(out.find((t) => t.id === "a")!.y).toBeGreaterThanOrEqual(1);
    expect(out.find((t) => t.id === "b")!.y).toBe(0);
  });
});

describe("moveTile", () => {
  it("commits a valid move and compacts neighbours", () => {
    const board = [
      tile("a", 0, 0, 1, 1),
      tile("b", 1, 0, 1, 1),
      tile("c", 2, 0, 1, 1),
    ];
    const out = moveTile(board, "b", { x: 0, y: 0 });
    const b = out.find((t) => t.id === "b")!;
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it("clamps x within the grid", () => {
    const board = [tile("a", 0, 0, 1, 1)];
    const out = moveTile(board, "a", { x: 99, y: 0 });
    const a = out.find((t) => t.id === "a")!;
    expect(a.x).toBe(2); // 3 - 1
  });

  it("swaps when dropping a same-size tile on top of another", () => {
    const board = [tile("a", 0, 0, 1, 1), tile("b", 2, 0, 1, 1)];
    const out = moveTile(board, "a", { x: 2, y: 0 });
    const a = out.find((t) => t.id === "a")!;
    const b = out.find((t) => t.id === "b")!;
    expect(a).toMatchObject({ x: 2, y: 0 });
    expect(b).toMatchObject({ x: 0, y: 0 });
  });
});

describe("resizeTile", () => {
  it("changes size and pushes neighbours that no longer fit", () => {
    const board = [tile("a", 0, 0, 1, 1), tile("b", 1, 0, 1, 1)];
    const out = resizeTile(board, "a", { w: 2, h: 1 });
    const a = out.find((t) => t.id === "a")!;
    const b = out.find((t) => t.id === "b")!;
    expect(a.w).toBe(2);
    expect(b.y).toBeGreaterThanOrEqual(1);
  });
});

describe("findFirstFreeSlot", () => {
  it("picks the top-left free cell", () => {
    const board = [tile("a", 0, 0, 1, 1)];
    const slot = findFirstFreeSlot(board, 1, 1);
    expect(slot).toEqual({ x: 1, y: 0 });
  });

  it("falls back below all tiles when no row has space", () => {
    const board = [tile("a", 0, 0, 3, 2)];
    const slot = findFirstFreeSlot(board, 2, 1);
    expect(slot.y).toBeGreaterThanOrEqual(2);
  });
});

describe("insertTile / removeTile", () => {
  it("inserts at first free slot", () => {
    const board = [tile("a", 0, 0, 1, 1)];
    const out = insertTile(board, { id: "b", type: "x", w: 1, h: 1 });
    expect(out.find((t) => t.id === "b")).toEqual({
      id: "b",
      type: "x",
      x: 1,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it("removes and recompacts the column", () => {
    const board = [
      tile("a", 0, 0, 1, 1),
      tile("b", 0, 1, 1, 1),
      tile("c", 0, 2, 1, 1),
    ];
    const out = removeTile(board, "b");
    expect(out).toHaveLength(2);
    const c = out.find((t) => t.id === "c")!;
    expect(c.y).toBe(1);
  });
});
