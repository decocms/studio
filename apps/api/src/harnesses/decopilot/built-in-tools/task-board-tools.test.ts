/**
 * createTaskBoardTools — the Super Agent's only route to the board, so the
 * registered names are the contract the guide prompts call by name.
 */

import { describe, expect, test } from "bun:test";
import { createTaskBoardTools } from "./task-board-tools";

describe("createTaskBoardTools", () => {
  test("registers the task-board tools under their raw names", () => {
    // ctx is only read inside execute(), never during construction.
    const tools = createTaskBoardTools({} as never);

    expect(Object.keys(tools).sort()).toEqual([
      "TASK_BOARD_ITEM_CREATE",
      "TASK_BOARD_ITEM_DELETE",
      "TASK_BOARD_ITEM_LIST",
      "TASK_BOARD_ITEM_PRS_GET",
      "TASK_BOARD_ITEM_UPDATE",
      "TASK_BOARD_REVIEW_DECISION",
    ]);
  });
});
