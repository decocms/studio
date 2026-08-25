import { describe, expect, test } from "bun:test";
import { TASK_BOARD_DISMISSED_RESTORE } from "./dismissed";

describe("TASK_BOARD_DISMISSED_RESTORE input schema", () => {
  test("accepts a reasonably sized externalKeys array", () => {
    const result = TASK_BOARD_DISMISSED_RESTORE.inputSchema.safeParse({
      externalKeys: ["a", "b"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an externalKeys array over the bound", () => {
    const result = TASK_BOARD_DISMISSED_RESTORE.inputSchema.safeParse({
      externalKeys: Array.from({ length: 1001 }, (_, i) => `key_${i}`),
    });
    expect(result.success).toBe(false);
  });
});
