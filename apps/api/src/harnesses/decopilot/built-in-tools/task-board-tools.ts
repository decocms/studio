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

import { tool, zodSchema, type JSONValue, type ToolSet } from "ai";
import type { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import type { Tool as StudioTool } from "@/core/define-tool";
import { truncateForModel } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";
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

export function createTaskBoardTools(
  ctx: StudioContext,
  toolOutputMap: Map<string, string>,
): ToolSet {
  /**
   * The cap every MCP tool already had and these did not.
   *
   * `TASK_BOARD_ITEM_LIST` on a busy org is 1.4 MB — ~360k tokens, half of it
   * per-card linked-thread records and a third card descriptions — and it went
   * into the context whole. The model now gets a preview and greps the rest
   * back with `read_tool_output`, the same deal the MCP tools get.
   */
  const toModelOutput = ({
    output,
    toolCallId,
  }: {
    output: unknown;
    toolCallId: string;
  }) =>
    truncateForModel(output, toolCallId, toolOutputMap) ?? {
      type: "json",
      value: output as JSONValue,
    };

  const wrap = (def: StudioTool<z.ZodTypeAny, z.ZodTypeAny>) =>
    tool({
      description: def.description,
      inputSchema: zodSchema(def.inputSchema),
      execute: (input) => def.execute(input, ctx),
      toModelOutput,
    });

  return {
    TASK_BOARD_ITEM_LIST: wrap(TASK_BOARD_ITEM_LIST),
    TASK_BOARD_ITEM_CREATE: wrap(TASK_BOARD_ITEM_CREATE),
    TASK_BOARD_ITEM_UPDATE: wrap(TASK_BOARD_ITEM_UPDATE),
    TASK_BOARD_ITEM_DELETE: wrap(TASK_BOARD_ITEM_DELETE),
    TASK_BOARD_ITEM_PRS_GET: wrap(TASK_BOARD_ITEM_PRS_GET),
    // The board's analytics, and the orgs a cross-org read may name.
    // Without these the agent cannot answer the questions the two Grafana
    // dashboards answer, and cannot discover the orgs the `org` parameter on
    // the read tools above accepts — it can only be handed a slug and guess.
    TASK_BOARD_ADMIN_ORG_LIST: wrap(TASK_BOARD_ADMIN_ORG_LIST),
    TASK_BOARD_DELIVERY: wrap(TASK_BOARD_DELIVERY),
    TASK_BOARD_STUCK: wrap(TASK_BOARD_STUCK),
    TASK_BOARD_COST: wrap(TASK_BOARD_COST),
    TASK_BOARD_QUALITY: wrap(TASK_BOARD_QUALITY),
    TASK_BOARD_ERRORS: wrap(TASK_BOARD_ERRORS),
    TASK_BOARD_TENANTS: wrap(TASK_BOARD_TENANTS),
  };
}
