/**
 * EVENT_CANCEL Tool
 *
 * Cancels a recurring event to stop future deliveries.
 * Only the publisher connection can cancel its own events.
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { CancelEventInputSchema, CancelEventOutputSchema } from "./schema";

export const EVENT_CANCEL = defineTool({
  name: "EVENT_CANCEL",
  description:
    "Stop a recurring event from delivering further. Only the original publisher can cancel.",
  annotations: {
    title: "Cancel Recurring Event",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CancelEventInputSchema,
  outputSchema: CancelEventOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Get the connection ID from the caller's token
    const connectionId = ctx.connectionId;
    if (!connectionId) {
      throw new Error(
        "Connection ID required to cancel events. Use a connection-scoped token.",
      );
    }

    // Verify the event exists and belongs to this organization
    const event = await ctx.eventBus.getEvent(organization.id, input.eventId);
    if (!event) {
      throw new Error(`Event not found: ${input.eventId}`);
    }

    // Attempt to cancel (storage layer verifies ownership)
    const result = await ctx.eventBus.cancelEvent(
      organization.id,
      input.eventId,
      connectionId,
    );

    if (!result.success) {
      throw new Error(
        "Failed to cancel event. Either the event is already completed/failed, or you are not the publisher.",
      );
    }

    return {
      success: true,
      eventId: input.eventId,
    };
  },
});
