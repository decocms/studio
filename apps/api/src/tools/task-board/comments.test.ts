import { describe, expect, it } from "bun:test";
import {
  TASK_BOARD_COMMENT_CREATE,
  TASK_BOARD_COMMENT_UPDATE,
} from "./comments";

/**
 * Regression: comment bodies had no length cap — an unbounded `text` column,
 * writable directly by any org member's tool call. A single oversized POST
 * could bloat a row (and everything that re-reads it: the activity feed, the
 * Jira mirror, agent prompt context) with no server-side limit at all.
 */
describe("task board comment body length", () => {
  it("TASK_BOARD_COMMENT_CREATE rejects a body over the cap", () => {
    const result = TASK_BOARD_COMMENT_CREATE.inputSchema.safeParse({
      taskBoardItemId: "tbi_1",
      body: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_COMMENT_CREATE accepts a body at the cap", () => {
    const result = TASK_BOARD_COMMENT_CREATE.inputSchema.safeParse({
      taskBoardItemId: "tbi_1",
      body: "x".repeat(50_000),
    });
    expect(result.success).toBe(true);
  });

  it("TASK_BOARD_COMMENT_UPDATE rejects a body over the cap", () => {
    const result = TASK_BOARD_COMMENT_UPDATE.inputSchema.safeParse({
      id: "cmt_1",
      body: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });
});
