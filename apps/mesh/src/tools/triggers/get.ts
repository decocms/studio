import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerIdInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_GET = defineTool({
  name: "TRIGGER_GET",
  description: "Get trigger details by ID",
  annotations: {
    title: "Get Trigger",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: TriggerIdInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const trigger = await ctx.storage.triggers.get(input.id);
    if (!trigger) throw new Error(`Trigger not found: ${input.id}`);
    return trigger;
  },
});
