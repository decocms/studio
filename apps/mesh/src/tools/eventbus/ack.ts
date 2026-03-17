/**
 * EVENT_ACK Tool
 *
 * Acknowledges delivery of an event.
 * Used when ON_EVENTS returns retryAfter - the subscriber must call EVENT_ACK
 * to confirm successful processing, otherwise the event will be re-delivered.
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { AckEventInputSchema, AckEventOutputSchema } from "./schema";

export const EVENT_ACK = defineTool({
  name: "EVENT_ACK",
  description:
    "Acknowledge event delivery after processing. Only needed for events received with retryAfter.",
  annotations: {
    title: "Acknowledge Event",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: AckEventInputSchema,
  outputSchema: AckEventOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Get the connection ID from the caller's token
    const connectionId = ctx.connectionId;
    if (!connectionId) {
      throw new Error(
        "Connection ID required to acknowledge events. Use a connection-scoped token.",
      );
    }

    // Acknowledge the event delivery
    const result = await ctx.eventBus.ackEvent(
      organization.id,
      input.eventId,
      connectionId,
    );

    if (!result.success) {
      throw new Error(
        "Failed to acknowledge event. Either the event was not found, already delivered, or you are not a subscriber.",
      );
    }

    return {
      success: true,
      eventId: input.eventId,
    };
  },
});
