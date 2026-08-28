import { describe, expect, it } from "bun:test";
import { TASK_BOARD_AUTOMATION_UPSERT } from "./automations";

/**
 * Regression: `prompt` had no length cap — an unbounded `text` column,
 * writable directly by any org member's tool call. Same gap as the task
 * description cap (#6574's sibling), just on the automation's instruction.
 */
describe("TASK_BOARD_AUTOMATION_UPSERT prompt length", () => {
  it("rejects a prompt over the cap", () => {
    const result = TASK_BOARD_AUTOMATION_UPSERT.inputSchema.safeParse({
      columnKey: "todo",
      prompt: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a prompt at the cap", () => {
    const result = TASK_BOARD_AUTOMATION_UPSERT.inputSchema.safeParse({
      columnKey: "todo",
      prompt: "x".repeat(50_000),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null prompt (the default instruction)", () => {
    const result = TASK_BOARD_AUTOMATION_UPSERT.inputSchema.safeParse({
      columnKey: "todo",
      prompt: null,
    });
    expect(result.success).toBe(true);
  });
});
