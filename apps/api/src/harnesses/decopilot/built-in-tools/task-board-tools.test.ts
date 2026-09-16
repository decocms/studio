/**
 * createTaskBoardTools — the Super Agent's only route to the board, so the
 * registered names are the contract the guide prompts call by name.
 *
 * And the schemas here are the ones the MODEL is handed — not `CORE_TOOLS`'.
 * That is how the cross-org `org` parameter, applied only at the `CORE_TOOLS`
 * registration site, reached everything except the caller it was asked for:
 * the agent answered "TASK_BOARD_ITEM_LIST takes no parameters", and it was
 * right. Assert on what this file produces.
 */

import { describe, expect, test } from "bun:test";
import { createTaskBoardTools } from "./task-board-tools";

// ctx is only read inside execute(), never during construction.
const tools = createTaskBoardTools({} as never);

/** The JSON Schema properties the model reads, as the `ai` SDK resolves them. */
function properties(name: string): string[] {
  const schema = tools[name]?.inputSchema as
    | { jsonSchema?: { properties?: Record<string, unknown> } }
    | undefined;
  return Object.keys(schema?.jsonSchema?.properties ?? {});
}

describe("createTaskBoardTools", () => {
  test("registers the task-board tools under their raw names", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "TASK_BOARD_ADMIN_ORG_LIST",
      "TASK_BOARD_COST",
      "TASK_BOARD_DELIVERY",
      "TASK_BOARD_ERRORS",
      "TASK_BOARD_ITEM_CREATE",
      "TASK_BOARD_ITEM_DELETE",
      "TASK_BOARD_ITEM_LIST",
      "TASK_BOARD_ITEM_PRS_GET",
      "TASK_BOARD_ITEM_UPDATE",
      "TASK_BOARD_QUALITY",
      "TASK_BOARD_STUCK",
      "TASK_BOARD_TENANTS",
    ]);
  });

  test("omits TASK_BOARD_REVIEW_DECISION — the reviewers own that verdict", () => {
    expect(tools).not.toHaveProperty("TASK_BOARD_REVIEW_DECISION");
  });

  test("advertises `org` on the cross-org reads", () => {
    expect(properties("TASK_BOARD_ITEM_LIST")).toContain("org");
    expect(properties("TASK_BOARD_ITEM_PRS_GET")).toContain("org");
  });

  test("does NOT advertise `org` on the writes — cross-org writes are not shipped", () => {
    expect(properties("TASK_BOARD_ITEM_CREATE")).not.toContain("org");
    expect(properties("TASK_BOARD_ITEM_UPDATE")).not.toContain("org");
  });
});
