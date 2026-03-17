/**
 * EVENT_SYNC_SUBSCRIPTIONS Tool
 *
 * Syncs subscriptions to a desired state.
 * Creates new subscriptions, deletes removed ones, and updates changed filters.
 * Subscriptions are identified by (eventType, publisher).
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  SyncSubscriptionsInputSchema,
  SyncSubscriptionsOutputSchema,
} from "./schema";

export const EVENT_SYNC_SUBSCRIPTIONS = defineTool({
  name: "EVENT_SYNC_SUBSCRIPTIONS",
  description:
    "Declaratively sync subscriptions: creates new, deletes removed, updates changed filters.",
  annotations: {
    title: "Sync Event Subscriptions",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: SyncSubscriptionsInputSchema,
  outputSchema: SyncSubscriptionsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Get the subscriber connection ID from the caller's token
    const connectionId = ctx.connectionId;
    if (!connectionId) {
      throw new Error(
        "Connection ID required to sync subscriptions. Use a connection-scoped token.",
      );
    }

    // Sync the subscriptions
    const result = await ctx.eventBus.syncSubscriptions(organization.id, {
      connectionId,
      subscriptions: input.subscriptions,
    });

    return {
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      unchanged: result.unchanged,
      subscriptions: result.subscriptions.map((sub) => ({
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
