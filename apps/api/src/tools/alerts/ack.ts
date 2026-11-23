import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { emitAlertsUpdated } from "./events";
import { AlertSchema } from "./schema";

export const ALERT_ACK = defineTool({
  name: "ALERT_ACK",
  description:
    "Acknowledge an alert once it has been looked at, so it leaves the open list. Pass `taskBoardItemId` when a task was opened for it, and a short `note` on what was found. The same rule on the same subject can alert again after this.",
  annotations: {
    title: "Acknowledge Alert",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    note: z.string().max(2000).optional(),
    taskBoardItemId: z.string().optional(),
  }),
  outputSchema: z.object({ alert: AlertSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    // The link is the tenancy boundary for the task: it must be this org's.
    if (
      input.taskBoardItemId &&
      !(await ctx.storage.taskBoard.getById(input.taskBoardItemId, org.id))
    ) {
      throw new Error("Task board item not found");
    }
    const alert = await ctx.storage.alerts.ack(
      org.id,
      input.id,
      getUserId(ctx)!,
      { note: input.note, taskBoardItemId: input.taskBoardItemId },
    );
    if (!alert) throw new Error("Alert not found");
    emitAlertsUpdated(org.id, alert.id);
    return { alert };
  },
});
