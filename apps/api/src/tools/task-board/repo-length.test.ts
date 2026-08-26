import { describe, expect, it } from "bun:test";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

/**
 * Regression: a task's `repo` had no length cap — an unbounded `text` column,
 * writable directly by any org member's tool call. Same gap as the title cap
 * (#6577) and the description cap (#6576), just on the sibling field.
 */
describe("task board item repo length", () => {
  it("TASK_BOARD_ITEM_CREATE rejects a repo over the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "task",
      repo: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_CREATE accepts a repo at the cap", () => {
    const result = TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
      title: "task",
      repo: "x".repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it("TASK_BOARD_ITEM_UPDATE rejects a repo over the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      repo: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_ITEM_UPDATE accepts a repo at the cap", () => {
    const result = TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
      id: "tbi_1",
      repo: "x".repeat(200),
    });
    expect(result.success).toBe(true);
  });
});
