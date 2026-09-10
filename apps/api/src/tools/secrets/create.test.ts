import { describe, expect, test } from "bun:test";
import { MAX_SECRET_VALUE_LENGTH, SECRET_CREATE } from "./create";

describe("SECRET_CREATE input schema", () => {
  const base = { scope: "organization" as const, name: "api-key" };

  test("accepts a value at the length cap", () => {
    const result = SECRET_CREATE.inputSchema.safeParse({
      ...base,
      value: "a".repeat(MAX_SECRET_VALUE_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  test("rejects a value over the length cap", () => {
    const result = SECRET_CREATE.inputSchema.safeParse({
      ...base,
      value: "a".repeat(MAX_SECRET_VALUE_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});
