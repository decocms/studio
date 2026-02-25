import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { UpdateTriggerInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_UPDATE = defineTool({
  name: "TRIGGER_UPDATE",
  description: "Update trigger configuration (including enable/disable)",
  annotations: {
    title: "Update Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateTriggerInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const { id, ...updates } = input;
    const trigger = await ctx.storage.triggers.update(id, {
      ...updates,
      updatedBy: ctx.user.id,
    });
    return trigger;
  },
});
