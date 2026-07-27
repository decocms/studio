import { describe, expect, test } from "bun:test";
import { ThreadUpdateDataSchema } from "./schema.ts";

describe("ThreadUpdateDataSchema", () => {
  test("rejects an empty-string branch", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: "" });
    expect(result.success).toBe(false);
  });

  test("accepts null branch (clears the pin)", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: null });
    expect(result.success).toBe(true);
  });

  test("accepts a non-empty branch name", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: "feat/foo" });
    expect(result.success).toBe(true);
  });

  test("accepts omitted branch (no change)", () => {
    const result = ThreadUpdateDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
