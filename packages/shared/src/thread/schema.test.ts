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

  test("rejects the server-managed sandbox map", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: { sandboxMap: {} },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized expanded_tools array", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: {
        expanded_tools: Array.from({ length: 201 }, (_, i) => ({
          toolName: `tool_${i}`,
          appId: "app",
          args: {},
          expandedAt: new Date().toISOString(),
        })),
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized jira_issue_keys array", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: {
        jira_issue_keys: Array.from({ length: 201 }, (_, i) => `EX-${i}`),
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an oversized jira_issue_key string", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: { jira_issue_key: "a".repeat(501) },
    });
    expect(result.success).toBe(false);
  });

  test("accepts metadata within the bounds", () => {
    const result = ThreadUpdateDataSchema.safeParse({
      metadata: {
        expanded_tools: [
          {
            toolName: "FOO",
            appId: "app",
            args: {},
            expandedAt: new Date().toISOString(),
          },
        ],
        jira_issue_keys: ["EX-1", "EX-2"],
      },
    });
    expect(result.success).toBe(true);
  });
});
