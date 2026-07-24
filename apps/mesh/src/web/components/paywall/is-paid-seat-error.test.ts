import { describe, expect, test } from "bun:test";
import { isPaidSeatError } from "./is-paid-seat-error.ts";

describe("isPaidSeatError", () => {
  test("matches the [PAID_SEAT_REQUIRED] prefix", () => {
    expect(
      isPaidSeatError(new Error("[PAID_SEAT_REQUIRED] needs a paid seat")),
    ).toBe(true);
  });

  test("prefix must be at the start, not mid-message", () => {
    expect(
      isPaidSeatError(new Error("wrapped: [PAID_SEAT_REQUIRED] nope")),
    ).toBe(false);
  });

  test("unrelated errors do not match", () => {
    expect(isPaidSeatError(new Error("boom"))).toBe(false);
    expect(isPaidSeatError(new Error("[CREDITS] out of credits"))).toBe(false);
  });

  test("null / undefined are safe", () => {
    expect(isPaidSeatError(null)).toBe(false);
    expect(isPaidSeatError(undefined)).toBe(false);
  });
});
