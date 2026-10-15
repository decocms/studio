import { describe, expect, test } from "bun:test";
import {
  MAX_THREAD_DESCRIPTION_LENGTH,
  MAX_THREAD_TITLE_LENGTH,
  ThreadCreateDataSchema,
  ThreadUpdateDataSchema,
} from "./schema.ts";

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

  test("rejects the server-managed sandbox map", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: { sandboxMap: {} },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized title", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      title: "a".repeat(MAX_THREAD_TITLE_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized description", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      description: "a".repeat(MAX_THREAD_DESCRIPTION_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

describe("ThreadCreateDataSchema", () => {
  test("rejects an oversized title", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      title: "a".repeat(MAX_THREAD_TITLE_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized description", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      description: "a".repeat(MAX_THREAD_DESCRIPTION_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("accepts a title and description at the cap", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      title: "a".repeat(MAX_THREAD_TITLE_LENGTH),
      description: "a".repeat(MAX_THREAD_DESCRIPTION_LENGTH),
    });
    expect(result.success).toBe(true);
  });
});
