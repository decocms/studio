import { describe, expect, test } from "bun:test";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { columnSentence } from "./column-guide";

describe("columnSentence", () => {
  /** A card out of play has nothing left to explain. */
  test("every column but Done and Archived explains itself", () => {
    const silent = CANONICAL_COLUMN_KEYS.filter(
      (key) => columnSentence(key) === null,
    );
    expect(silent).toEqual(["done", "archived"]);
  });

  test("a column the board doesn't have has no sentence", () => {
    expect(columnSentence("custom_lane")).toBeNull();
  });
});
