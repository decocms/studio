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
 * reviewer verdict belongs to the reviewer, which reaches the tool over
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
import {
  TASK_BOARD_ADMIN_ORG_LIST,
  TASK_BOARD_COST,
  TASK_BOARD_DELIVERY,
  TASK_BOARD_ERRORS,
  TASK_BOARD_QUALITY,
  TASK_BOARD_STUCK,
  TASK_BOARD_TENANTS,
} from "@/tools/task-board/analytics";

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
    // The board's analytics, and the orgs a cross-org read may name.
    // Without these the agent cannot answer the questions the two Grafana
    // dashboards answer, and cannot discover the orgs the `org` parameter on
    // the read tools above accepts — it can only be handed a slug and guess.
    TASK_BOARD_ADMIN_ORG_LIST: tool({
      description: TASK_BOARD_ADMIN_ORG_LIST.description,
      inputSchema: zodSchema(TASK_BOARD_ADMIN_ORG_LIST.inputSchema),
      execute: (input) => TASK_BOARD_ADMIN_ORG_LIST.execute(input, ctx),
    }),
    TASK_BOARD_DELIVERY: tool({
      description: TASK_BOARD_DELIVERY.description,
      inputSchema: zodSchema(TASK_BOARD_DELIVERY.inputSchema),
      execute: (input) => TASK_BOARD_DELIVERY.execute(input, ctx),
    }),
    TASK_BOARD_STUCK: tool({
      description: TASK_BOARD_STUCK.description,
      inputSchema: zodSchema(TASK_BOARD_STUCK.inputSchema),
      execute: (input) => TASK_BOARD_STUCK.execute(input, ctx),
    }),
    TASK_BOARD_COST: tool({
      description: TASK_BOARD_COST.description,
      inputSchema: zodSchema(TASK_BOARD_COST.inputSchema),
      execute: (input) => TASK_BOARD_COST.execute(input, ctx),
    }),
    TASK_BOARD_QUALITY: tool({
      description: TASK_BOARD_QUALITY.description,
      inputSchema: zodSchema(TASK_BOARD_QUALITY.inputSchema),
      execute: (input) => TASK_BOARD_QUALITY.execute(input, ctx),
    }),
    TASK_BOARD_ERRORS: tool({
      description: TASK_BOARD_ERRORS.description,
      inputSchema: zodSchema(TASK_BOARD_ERRORS.inputSchema),
      execute: (input) => TASK_BOARD_ERRORS.execute(input, ctx),
    }),
    TASK_BOARD_TENANTS: tool({
      description: TASK_BOARD_TENANTS.description,
      inputSchema: zodSchema(TASK_BOARD_TENANTS.inputSchema),
      execute: (input) => TASK_BOARD_TENANTS.execute(input, ctx),
    }),
  };
}
