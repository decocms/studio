import { describe, expect, test } from "bun:test";
import { taskManagerAgent } from "./task-manager";

describe("taskManagerAgent", () => {
  test("uses an org-scoped id", () => {
    expect(taskManagerAgent.getId("org_xyz")).toBe(
      "studio-task-manager_org_xyz",
    );
  });

  test("exposes only task-board tools", () => {
    expect(taskManagerAgent.selectedTools).toEqual([
      "TASK_BOARD_ITEM_CREATE",
      "TASK_BOARD_ITEM_LIST",
      "TASK_BOARD_ITEM_UPDATE",
      "TASK_BOARD_ITEM_DELETE",
      "TASK_BOARD_ITEM_PRS_GET",
    ]);
  });

  test("handles safe deletion and Super Agent delegation", () => {
    expect(taskManagerAgent.instructions).toContain(
      "explicit confirmation immediately before deleting a task",
    );
    expect(taskManagerAgent.instructions).toContain(
      "assignee id `super-agent`",
    );
    expect(taskManagerAgent.instructions).toContain(
      "editing it does not enqueue a fresh run",
    );
  });
});
