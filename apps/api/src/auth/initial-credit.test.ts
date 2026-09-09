import { describe, expect, it } from "bun:test";
import { readInitialCreditCents } from "./initial-credit";

describe("readInitialCreditCents", () => {
  it("reads a valid amount from an object", () => {
    expect(readInitialCreditCents({ initialCreditCents: 2500 })).toBe(2500);
  });

  it("reads a valid amount from a JSON string (as Better Auth may pass it)", () => {
    expect(
      readInitialCreditCents(JSON.stringify({ initialCreditCents: 1000 })),
    ).toBe(1000);
  });

  it("accepts 0 (explicit no-grant)", () => {
    expect(readInitialCreditCents({ initialCreditCents: 0 })).toBe(0);
  });

  it("preserves other metadata keys without interfering", () => {
    expect(
      readInitialCreditCents({ description: "x", initialCreditCents: 500 }),
    ).toBe(500);
  });

  it("falls back to undefined for non-object / missing / malformed input", () => {
    for (const input of [
      undefined,
      null,
      "",
      "not json",
      42,
      [],
      { other: 1 },
    ]) {
      expect(readInitialCreditCents(input)).toBeUndefined();
    }
  });

  it("rejects out-of-range or non-integer amounts", () => {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      100_001,
    ]) {
      expect(
        readInitialCreditCents({ initialCreditCents: value }),
      ).toBeUndefined();
    }
  });

  it("accepts exactly the cap", () => {
    expect(readInitialCreditCents({ initialCreditCents: 100_000 })).toBe(
      100_000,
    );
  });
});
