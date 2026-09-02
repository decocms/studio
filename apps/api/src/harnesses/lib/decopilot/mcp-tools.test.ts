import { describe, expect, it } from "bun:test";
import { hasLlmSafeInputSchema } from "./mcp-tools";

describe("hasLlmSafeInputSchema", () => {
  it("accepts safe keys and schemas without properties", () => {
    expect(hasLlmSafeInputSchema({ type: "object" })).toBe(true);
    expect(
      hasLlmSafeInputSchema({ properties: { "a.b-c_1": {}, x: {} } }),
    ).toBe(true);
  });

  it("rejects invalid characters, empty keys and keys over 64 chars", () => {
    expect(
      hasLlmSafeInputSchema({ properties: { "site/sections/A.tsx": {} } }),
    ).toBe(false);
    expect(hasLlmSafeInputSchema({ properties: { "": {} } })).toBe(false);
    expect(
      hasLlmSafeInputSchema({ properties: { [`k${"x".repeat(64)}`]: {} } }),
    ).toBe(false);
  });
});
