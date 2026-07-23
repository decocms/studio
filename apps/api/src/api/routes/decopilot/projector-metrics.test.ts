import { describe, expect, test } from "bun:test";
import { computeLagMs } from "./projector-metrics";
describe("computeLagMs", () => {
  test("lag is now - message publish time", () => {
    expect(computeLagMs(1000, 1700)).toBe(700);
  });
  test("never negative (clock skew)", () => {
    expect(computeLagMs(2000, 1000)).toBe(0);
  });
});
