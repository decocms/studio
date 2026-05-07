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
    const out = compactBoard([tile("a", 0, 5, 4, 2)]);
    expect(out[0]!.y).toBe(0);
  });

  it("preserves stacking order top-to-bottom", () => {
    const out = compactBoard([tile("b", 0, 4, 4, 2), tile("a", 0, 1, 4, 2)]);
    const a = out.find((t) => t.id === "a")!;
    const b = out.find((t) => t.id === "b")!;
    expect(a.y).toBe(0);
    expect(b.y).toBe(2);
  });

  it("packs side-by-side tiles into the same row", () => {
    const out = compactBoard([tile("a", 0, 7, 4, 2), tile("b", 4, 9, 4, 2)]);
    expect(out.find((t) => t.id === "a")!.y).toBe(0);
    expect(out.find((t) => t.id === "b")!.y).toBe(0);
  });
});

describe("resolveCollisions", () => {
  it("pushes overlapping tiles down", () => {
    const others = [tile("a", 0, 0, 4, 2)];
    const pinned = tile("b", 0, 0, 4, 2);
    const out = resolveCollisions(pinned, others);
    expect(out.find((t) => t.id === "a")!.y).toBeGreaterThanOrEqual(2);
    expect(out.find((t) => t.id === "b")!.y).toBe(0);
  });
});

describe("moveTile", () => {
  it("commits a valid move and compacts neighbours", () => {
    const board = [
      tile("a", 0, 0, 4, 2),
      tile("b", 4, 0, 4, 2),
      tile("c", 8, 0, 4, 2),
    ];
    const out = moveTile(board, "b", { x: 0, y: 0 });
    const b = out.find((t) => t.id === "b")!;
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it("clamps x within the grid", () => {
    const board = [tile("a", 0, 0, 4, 2)];
    const out = moveTile(board, "a", { x: 99, y: 0 });
    const a = out.find((t) => t.id === "a")!;
    expect(a.x).toBe(8); // 12 - 4
  });
});

describe("resizeTile", () => {
  it("changes size and pushes neighbours that no longer fit", () => {
    const board = [tile("a", 0, 0, 4, 2), tile("b", 4, 0, 4, 2)];
    const out = resizeTile(board, "a", { w: 8, h: 2 });
    const a = out.find((t) => t.id === "a")!;
    const b = out.find((t) => t.id === "b")!;
    expect(a.w).toBe(8);
    expect(b.y).toBeGreaterThanOrEqual(2);
  });
});

describe("findFirstFreeSlot", () => {
  it("picks the top-left free cell", () => {
    const board = [tile("a", 0, 0, 4, 2)];
    const slot = findFirstFreeSlot(board, 4, 2);
    expect(slot).toEqual({ x: 4, y: 0 });
  });

  it("falls back below all tiles when no row has space", () => {
    const board = [tile("a", 0, 0, 12, 4)];
    const slot = findFirstFreeSlot(board, 6, 2);
    expect(slot.y).toBeGreaterThanOrEqual(4);
  });
});

describe("insertTile / removeTile", () => {
  it("inserts at first free slot", () => {
    const board = [tile("a", 0, 0, 4, 2)];
    const out = insertTile(board, { id: "b", type: "x", w: 4, h: 2 });
    expect(out.find((t) => t.id === "b")).toEqual({
      id: "b",
      type: "x",
      x: 4,
      y: 0,
      w: 4,
      h: 2,
    });
  });

  it("removes and recompacts", () => {
    const board = [
      tile("a", 0, 0, 4, 2),
      tile("b", 0, 2, 4, 2),
      tile("c", 0, 4, 4, 2),
    ];
    const out = removeTile(board, "b");
    expect(out).toHaveLength(2);
    const c = out.find((t) => t.id === "c")!;
    expect(c.y).toBe(2);
  });
});
