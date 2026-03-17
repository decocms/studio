/**
 * EVENT_PUBLISH Tool
 *
 * Publishes an event to the event bus.
 * The source connection ID is automatically set from the caller's auth token.
 *
 * Supports three delivery modes:
 * - Immediate: No deliverAt or cron specified
 * - Scheduled: deliverAt specifies a one-time future delivery
 * - Recurring: cron expression for repeated delivery (use EVENT_CANCEL to stop)
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PublishEventInputSchema, PublishEventOutputSchema } from "./schema";

export const EVENT_PUBLISH = defineTool({
  name: "EVENT_PUBLISH",
  description:
    "Publish an event. Supports immediate, scheduled (deliverAt), and recurring (cron) delivery.\n\n- Source is auto-set to the caller's connection ID.\n- Use EVENT_CANCEL to stop recurring events.",
  annotations: {
    title: "Publish Event",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: PublishEventInputSchema,
  outputSchema: PublishEventOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Get the source connection ID from the caller's token
    const sourceConnectionId = ctx.connectionId;
    if (!sourceConnectionId) {
      throw new Error(
        "Connection ID required to publish events. Use a connection-scoped token.",
      );
    }

    // Publish the event (optionally scheduled or recurring)
    const event = await ctx.eventBus.publish(
      organization.id,
      sourceConnectionId,
      {
        type: input.type,
        subject: input.subject,
        data: input.data,
        deliverAt: input.deliverAt,
        cron: input.cron,
      },
    );

    return {
      id: event.id,
      type: event.type,
      source: event.source,
      time: event.time,
    };
  },
});
