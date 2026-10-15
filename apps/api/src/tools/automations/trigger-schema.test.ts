import { describe, expect, test } from "bun:test";
import { TriggerParamsSchema } from "./trigger-schema";

describe("TriggerParamsSchema", () => {
  test("accepts a small params object", () => {
    expect(TriggerParamsSchema.safeParse({ foo: "bar" }).success).toBe(true);
  });

  test("rejects more than 50 entries", () => {
    const params = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(TriggerParamsSchema.safeParse(params).success).toBe(false);
  });

  test("rejects a value over the string length cap", () => {
    expect(
      TriggerParamsSchema.safeParse({ foo: "a".repeat(2001) }).success,
    ).toBe(false);
  });

  test("rejects a key over the string length cap", () => {
    expect(
      TriggerParamsSchema.safeParse({ [`a`.repeat(2001)]: "bar" }).success,
    ).toBe(false);
  });
});
