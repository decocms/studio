/**
 * EVENT_SUBSCRIBE Tool
 *
 * Creates a subscription to receive events.
 * The subscriber connection ID is automatically set from the caller's auth token.
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { SubscribeInputSchema, SubscribeOutputSchema } from "./schema";

export const EVENT_SUBSCRIBE = defineTool({
  name: "EVENT_SUBSCRIBE",
  description:
    "Subscribe to events of a specific type. Caller's connection is set as subscriber automatically.",
  annotations: {
    title: "Subscribe to Events",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: SubscribeInputSchema,
  outputSchema: SubscribeOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Get the subscriber connection ID from the caller's token
    const connectionId = ctx.connectionId;
    if (!connectionId) {
      throw new Error(
        "Connection ID required to subscribe. Use a connection-scoped token.",
      );
    }
    // Create the subscription
    const subscription = await ctx.eventBus.subscribe(organization.id, {
      connectionId,
      eventType: input.eventType,
      publisher: input.publisher,
      filter: input.filter,
    });

    return {
      subscription: {
        id: subscription.id,
        connectionId: subscription.connectionId,
        eventType: subscription.eventType,
        publisher: subscription.publisher,
        filter: subscription.filter,
        enabled: subscription.enabled,
        createdAt:
          subscription.createdAt instanceof Date
            ? subscription.createdAt.toISOString()
            : subscription.createdAt,
        updatedAt:
          subscription.updatedAt instanceof Date
            ? subscription.updatedAt.toISOString()
            : subscription.updatedAt,
      },
    };
  },
});
