import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerIdInputSchema, DeleteTriggerOutputSchema } from "./schema";

export const TRIGGER_DELETE = defineTool({
  name: "TRIGGER_DELETE",
  description: "Delete a trigger and clean up its event bus references",
  annotations: {
    title: "Delete Trigger",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: TriggerIdInputSchema,
  outputSchema: DeleteTriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const trigger = await ctx.storage.triggers.get(input.id);
    if (!trigger) throw new Error(`Trigger not found: ${input.id}`);

    // TODO: Clean up event bus references (cancel cron event, unsubscribe)

    await ctx.storage.triggers.delete(input.id);
    return { success: true };
  },
});
