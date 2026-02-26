import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  TriggerRunsListInputSchema,
  TriggerRunsListOutputSchema,
} from "./schema";

export const TRIGGER_RUNS_LIST = defineTool({
  name: "TRIGGER_RUNS_LIST",
  description: "List recent task runs for a trigger",
  annotations: {
    title: "List Trigger Runs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: TriggerRunsListInputSchema,
  outputSchema: TriggerRunsListOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const threads = await ctx.storage.threads.listByTriggerId(input.triggerId, {
      limit: input.limit,
    });

    return {
      runs: threads.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    };
  },
});
