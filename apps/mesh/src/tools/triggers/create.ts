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
    if (
      input.actionType === "tool_call" &&
      (!input.connectionId || !input.toolName)
    ) {
      throw new Error(
        "connectionId and toolName are required for tool_call actions",
      );
    }
    if (
      input.actionType === "agent_prompt" &&
      (!input.agentId || !input.agentPrompt)
    ) {
      throw new Error(
        "agentId and agentPrompt are required for agent_prompt actions",
      );
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
      createdBy: ctx.user.id,
    });

    return trigger;
  },
});
