import { describe, expect, it } from "bun:test";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TaskBoardItemSchema } from "./schema";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

describe("task board project ownership schemas", () => {
  it("accepts an explicit project owner on create and update", () => {
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
        title: "Project task",
        virtualMcpId: "vir_project",
      }).success,
    ).toBe(true);
    expect(
      TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
        id: "board_1",
        virtualMcpId: "vir_project",
      }).success,
    ).toBe(true);
  });

  it("accepts null for organization ownership and rejects non-string ids", () => {
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
        title: "Organization task",
        virtualMcpId: null,
      }).success,
    ).toBe(true);
    expect(
      TASK_BOARD_ITEM_UPDATE.inputSchema.safeParse({
        id: "board_1",
        virtualMcpId: 42,
      }).success,
    ).toBe(false);
    expect(
      TASK_BOARD_ITEM_CREATE.inputSchema.safeParse({
        title: "Bad owner",
        virtualMcpId: "   ",
      }).success,
    ).toBe(false);
  });

  it("requires every public task row to carry explicit nullable ownership", () => {
    const result = TaskBoardItemSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.path[0] === "virtualMcpId"),
    ).toBe(true);
  });
});
