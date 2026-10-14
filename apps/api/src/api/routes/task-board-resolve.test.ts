import { describe, expect, it } from "bun:test";
import { resolveBodySchema } from "./task-board-resolve";

const source = { url: "https://shop.example/", run_id: "run_1" };

describe("resolveBodySchema", () => {
  it("accepts card ids, an empty batch, and a repeated id", () => {
    for (const items of [
      [{ id: "board_a" }, { id: "board_b" }],
      [],
      [{ id: "board_a" }, { id: "board_a" }],
    ]) {
      expect(resolveBodySchema.safeParse({ items, source }).success).toBe(true);
    }
  });

  it("caps the batch at 100 items", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ id: `board_${i}` }));
    expect(resolveBodySchema.safeParse({ items, source }).success).toBe(false);
    expect(
      resolveBodySchema.safeParse({ items: items.slice(0, 100), source })
        .success,
    ).toBe(true);
  });

  it("requires a source url and run_id, and a non-empty card id", () => {
    for (const body of [
      { items: [{ id: "board_a" }] },
      { items: [{ id: "board_a" }], source: { url: source.url } },
      { items: [{ id: "board_a" }], source: { ...source, run_id: "" } },
      { items: [{ id: "board_a" }], source: { ...source, url: "" } },
      { items: [{ id: "" }], source },
      { source },
    ]) {
      expect(resolveBodySchema.safeParse(body).success).toBe(false);
    }
  });
});
