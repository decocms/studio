/**
 * Task activity log — the card's change timeline (created, status moved,
 * (re)assigned, sprint changed). `recordTaskActivity` is the best-effort writer
 * shared by the create/update tools and the run reactions; the list tool feeds
 * the Activity feed in the task dialog.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardActivityKind } from "@/storage/types";
import { TaskBoardActivitySchema } from "./schema";

/** Append an activity event, swallowing failures — a log write must never fail
 *  the change it describes. */
export async function recordTaskActivity(
  ctx: StudioContext,
  params: {
    organizationId: string;
    taskBoardItemId: string;
    kind: TaskBoardActivityKind;
    actorId: string | null;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await ctx.storage.taskBoard.recordActivity(params);
  } catch (err) {
    console.error("[task-board] activity log write failed", err);
  }
}

export const TASK_BOARD_ACTIVITY_LIST = defineTool({
  name: "TASK_BOARD_ACTIVITY_LIST",
  description:
    "List a task board item's change history (timeline, oldest first).",
  annotations: {
    title: "List Task Activity",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ activity: z.array(TaskBoardActivitySchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const activity = await ctx.storage.taskBoard.listActivity(
      input.taskBoardItemId,
      organizationId,
    );
    return { activity };
  },
});
