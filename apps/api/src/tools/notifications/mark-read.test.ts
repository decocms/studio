import { describe, expect, test } from "bun:test";
import { NOTIFICATION_MARK_READ } from "./mark-read";

describe("NOTIFICATION_MARK_READ input schema", () => {
  test("accepts a reasonably sized ids array", () => {
    const result = NOTIFICATION_MARK_READ.inputSchema.safeParse({
      ids: ["notif_1", "notif_2"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an ids array over the bound", () => {
    const result = NOTIFICATION_MARK_READ.inputSchema.safeParse({
      ids: Array.from({ length: 1001 }, (_, i) => `notif_${i}`),
    });
    expect(result.success).toBe(false);
  });
});
