import { describe, expect, test } from "bun:test";
import { reseedBlockItems, seedBlockItems } from "./block-items";
import { type RawBlock } from "./blocks/block-registry";

const block = (
  resolveType: string,
  extra?: Record<string, unknown>,
): RawBlock => ({ __resolveType: resolveType, ...extra }) as RawBlock;

describe("reseedBlockItems", () => {
  test("keeps every id when a save echo returns an equal-content new array", () => {
    // The bug: regenerating ids here remounts the list, losing focus + scroll.
    const seeded = seedBlockItems([block("paragraph"), block("heading")]);
    const echo = [block("paragraph"), block("heading")];
    const reseeded = reseedBlockItems(seeded, echo);

    expect(reseeded.map((x) => x.id)).toEqual(seeded.map((x) => x.id));
    expect(reseeded[0]!.block).toBe(echo[0]!);
    expect(reseeded[1]!.block).toBe(echo[1]!);
  });

  test("reuses ids by position and mints fresh ones for appended blocks", () => {
    const seeded = seedBlockItems([block("paragraph")]);
    const reseeded = reseedBlockItems(seeded, [
      block("paragraph"),
      block("heading"),
    ]);

    expect(reseeded[0]!.id).toBe(seeded[0]!.id);
    expect(reseeded[1]!.id).not.toBe(seeded[0]!.id);
    expect(reseeded).toHaveLength(2);
  });

  test("drops trailing ids when the value shrinks", () => {
    const seeded = seedBlockItems([block("paragraph"), block("heading")]);
    const reseeded = reseedBlockItems(seeded, [block("paragraph")]);

    expect(reseeded).toHaveLength(1);
    expect(reseeded[0]!.id).toBe(seeded[0]!.id);
  });

  test("seeds fresh ids from an empty previous list", () => {
    const reseeded = reseedBlockItems(
      [],
      [block("paragraph"), block("heading")],
    );

    expect(reseeded).toHaveLength(2);
    expect(reseeded[0]!.id).not.toBe(reseeded[1]!.id);
  });
});
