import { describe, expect, test } from "bun:test";
import { colCountOf } from "./table-block";

describe("colCountOf", () => {
  test("is the widest row", () => {
    expect(colCountOf(["a", "b"], [["1", "2", "3"], ["4"]])).toBe(3);
  });

  test("falls back to the header width with no rows", () => {
    expect(colCountOf(["a", "b", "c"], [])).toBe(3);
  });

  test("never goes below 1", () => {
    expect(colCountOf([], [[], []])).toBe(1);
  });

  test("doesn't overflow the call stack on a huge body", () => {
    const body = Array.from({ length: 200_000 }, () => ["1", "2"]);
    expect(colCountOf([], body)).toBe(2);
  });
});
