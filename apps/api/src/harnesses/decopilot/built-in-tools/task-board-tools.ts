/**
 * Task board built-ins
 *
 * Exposes the org's task-board tools to the Super Agent as always-available
 * built-ins. Decopilot aggregates no connections (`storage/virtual.ts`
 * findById returns `connections: []`), so before this it could only touch the
 * board by `subtask`-delegating to the retired Task Manager agent.
 *
 * Names are kept verbatim (`TASK_BOARD_*`) rather than snake_cased like the
 * other built-ins: the guide prompts and the reviewer instructions already
 * tell the model to call them by these names.
 *
 * `TASK_BOARD_REVIEW_DECISION` is deliberately NOT here: recording a QA /
 * Code Reviewer verdict belongs to those reviewers, which reach the tool over
 * their run-scoped MCP endpoint. The Super Agent is the reviewed party.
 *
 * Imported from the concrete tool files to keep this built-in set explicit.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { TASK_BOARD_ITEM_CREATE } from "@/tools/task-board/create";
import { TASK_BOARD_ITEM_LIST } from "@/tools/task-board/list";
import { TASK_BOARD_ITEM_UPDATE } from "@/tools/task-board/update";
import { TASK_BOARD_ITEM_DELETE } from "@/tools/task-board/delete";
import { TASK_BOARD_ITEM_PRS_GET } from "@/tools/task-board/prs-get";

export function createTaskBoardTools(ctx: StudioContext): ToolSet {
  return {
    TASK_BOARD_ITEM_LIST: tool({
      description: TASK_BOARD_ITEM_LIST.description,
      inputSchema: zodSchema(TASK_BOARD_ITEM_LIST.inputSchema),
      execute: (input) => TASK_BOARD_ITEM_LIST.execute(input, ctx),
    }),
    TASK_BOARD_ITEM_CREATE: tool({
      description: TASK_BOARD_ITEM_CREATE.description,
      inputSchema: zodSchema(TASK_BOARD_ITEM_CREATE.inputSchema),
      execute: (input) => TASK_BOARD_ITEM_CREATE.execute(input, ctx),
    }),
    TASK_BOARD_ITEM_UPDATE: tool({
      description: TASK_BOARD_ITEM_UPDATE.description,
      inputSchema: zodSchema(TASK_BOARD_ITEM_UPDATE.inputSchema),
      execute: (input) => TASK_BOARD_ITEM_UPDATE.execute(input, ctx),
    }),
    TASK_BOARD_ITEM_DELETE: tool({
      description: TASK_BOARD_ITEM_DELETE.description,
      inputSchema: zodSchema(TASK_BOARD_ITEM_DELETE.inputSchema),
      execute: (input) => TASK_BOARD_ITEM_DELETE.execute(input, ctx),
    }),
    TASK_BOARD_ITEM_PRS_GET: tool({
      description: TASK_BOARD_ITEM_PRS_GET.description,
      inputSchema: zodSchema(TASK_BOARD_ITEM_PRS_GET.inputSchema),
      execute: (input) => TASK_BOARD_ITEM_PRS_GET.execute(input, ctx),
    }),
  };
}
