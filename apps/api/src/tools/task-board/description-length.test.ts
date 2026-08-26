import { describe, expect, it } from "bun:test";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

/**
 * Regression: a task's `description` had no length cap — an unbounded
 * `text` column, writable directly by any org member's tool call. Same gap
 * as the comment body cap (#6574), just on the sibling field.
 */
describe("task board item description length", () => {
  it("TASK_BOARD_ITEM_CREATE rejects a description over the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "t",
      description: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_CREATE accepts a description at the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "t",
      description: "x".repeat(50_000),
    });
    expect(result.success).toBe(true);
  });

  it("TASK_BOARD_ITEM_UPDATE rejects a description over the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      description: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_UPDATE accepts a description at the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      description: "x".repeat(50_000),
    });
    expect(result.success).toBe(true);
  });
});
