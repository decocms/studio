import { describe, expect, it } from "bun:test";
import { isValidBalanceCents } from "./credits";

describe("isValidBalanceCents", () => {
  it("accepts a normal balance", () => {
    expect(isValidBalanceCents(1000)).toBe(true);
  });

  it("accepts a zero balance", () => {
    expect(isValidBalanceCents(0)).toBe(true);
  });

  it("rejects NaN (e.g. from a malformed gateway response)", () => {
    expect(isValidBalanceCents(Number.NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidBalanceCents(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects undefined coerced to a number position", () => {
    expect(isValidBalanceCents(undefined as unknown as number)).toBe(false);
  });
});
