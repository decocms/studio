import { describe, expect, test } from "bun:test";
import { nest, type TaskBoardComment } from "./use-task-board-comments";

const comment = (
  id: string,
  parentId: string | null = null,
): TaskBoardComment => ({
  id,
  taskBoardItemId: "task",
  parentId,
  authorId: "u1",
  body: id,
  resolved: false,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
});

describe("nest", () => {
  test("groups replies under their thread root, in order", () => {
    const threads = nest([
      comment("a"),
      comment("a-1", "a"),
      comment("b"),
      comment("a-2", "a"),
    ]);
    expect(threads.map((t) => t.id)).toEqual(["a", "b"]);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["a-1", "a-2"]);
    expect(threads[1]!.replies).toEqual([]);
  });

  test("drops a reply whose root is missing instead of losing the thread", () => {
    expect(nest([comment("orphan", "gone")])).toEqual([]);
  });
});
