/**
 * EVENT_SUBSCRIPTION_LIST Tool
 *
 * Lists subscriptions, optionally filtered by connection ID.
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  ListSubscriptionsInputSchema,
  ListSubscriptionsOutputSchema,
} from "./schema";

export const EVENT_SUBSCRIPTION_LIST = defineTool({
  name: "EVENT_SUBSCRIPTION_LIST",
  description:
    "List event subscriptions. Filter by connection ID to scope results.",
  annotations: {
    title: "List Event Subscriptions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ListSubscriptionsInputSchema,
  outputSchema: ListSubscriptionsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // List subscriptions
    const subscriptions = await ctx.eventBus.listSubscriptions(
      organization.id,
      input.connectionId,
    );

    return {
      subscriptions: subscriptions.map((sub) => ({
        id: sub.id,
        connectionId: sub.connectionId,
        eventType: sub.eventType,
        publisher: sub.publisher,
        filter: sub.filter,
        enabled: sub.enabled,
        createdAt:
          sub.createdAt instanceof Date
            ? sub.createdAt.toISOString()
            : sub.createdAt,
        updatedAt:
          sub.updatedAt instanceof Date
            ? sub.updatedAt.toISOString()
            : sub.updatedAt,
      })),
    };
  },
});
