import { describe, expect, test } from "bun:test";
import {
  MAX_THREAD_BRANCH_LENGTH,
  MAX_THREAD_ID_LENGTH,
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

  test("rejects an oversized branch", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      branch: "a".repeat(MAX_THREAD_BRANCH_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

describe("ThreadCreateDataSchema", () => {
  test("rejects an oversized custom id", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      id: "a".repeat(MAX_THREAD_ID_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized branch", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      branch: "a".repeat(MAX_THREAD_BRANCH_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("accepts an id and branch at the cap", () => {
    const result = ThreadCreateDataSchema.safeParse({
      virtual_mcp_id: "vmcp_test",
      id: "a".repeat(MAX_THREAD_ID_LENGTH),
      branch: "a".repeat(MAX_THREAD_BRANCH_LENGTH),
    });
    expect(result.success).toBe(true);
  });
});
