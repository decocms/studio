import { describe, expect, it } from "bun:test";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

/**
 * Regression: a task's `title` had no length cap — an unbounded `text`
 * column, writable directly by any org member's tool call. Same gap as the
 * description cap (#6576) and the comment body cap (#6574), just on the
 * sibling field.
 */
describe("task board item title length", () => {
  it("TASK_BOARD_ITEM_CREATE rejects a title over the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_CREATE accepts a title at the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("TASK_BOARD_ITEM_UPDATE rejects a title over the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      title: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_UPDATE accepts a title at the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      title: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });
});
