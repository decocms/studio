import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { CreateTriggerInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_CREATE = defineTool({
  name: "TRIGGER_CREATE",
  description:
    "Create a new trigger automation (cron schedule or event listener)",
  annotations: {
    title: "Create Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: CreateTriggerInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    if (input.triggerType === "cron" && !input.cronExpression) {
      throw new Error("cronExpression is required for cron triggers");
    }
    if (input.triggerType === "event" && !input.eventType) {
      throw new Error("eventType is required for event triggers");
    }

    const userId = ctx.auth.user?.id;
    if (!userId) {
      throw new Error("User authentication required");
    }

    const trigger = await ctx.storage.triggers.create({
      id: `trig_${crypto.randomUUID()}`,
      organizationId: organization.id,
      title: input.title,
      triggerType: input.triggerType,
      cronExpression: input.cronExpression,
      eventType: input.eventType,
      eventFilter: input.eventFilter,
      actionType: input.actionType,
      connectionId: input.connectionId,
      toolName: input.toolName,
      toolArguments: input.toolArguments,
      agentId: input.agentId,
      agentPrompt: input.agentPrompt,
      createdBy: userId,
    });

    return trigger;
  },
});
