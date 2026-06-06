import { describe, expect, test } from "bun:test";
import { isCancelRequested } from "./cancel-flag";

describe("isCancelRequested", () => {
  test("null → false (no cancel requested)", () => {
    expect(isCancelRequested(null)).toBe(false);
  });

  test("Date → true (cancel requested)", () => {
    expect(isCancelRequested(new Date())).toBe(true);
  });

  test("past Date → true (cancel requested in the past)", () => {
    expect(isCancelRequested(new Date("2020-01-01T00:00:00Z"))).toBe(true);
  });
});
