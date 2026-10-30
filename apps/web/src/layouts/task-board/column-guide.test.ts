import { describe, expect, test } from "bun:test";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { columnGuide } from "./column-guide";

describe("columnGuide", () => {
  test("every board column has a purpose", () => {
    for (const key of CANONICAL_COLUMN_KEYS) {
      expect(columnGuide(key)?.purpose).toBeTruthy();
    }
  });

  /** A person only has nothing to do once the card is out of play. */
  test("only finished columns leave the human step empty", () => {
    const empty = CANONICAL_COLUMN_KEYS.filter(
      (key) => columnGuide(key)?.human === null,
    );
    expect(empty).toEqual(["done", "archived"]);
  });

  test("a column the board doesn't have has no guide", () => {
    expect(columnGuide("custom_lane")).toBeNull();
  });
});
