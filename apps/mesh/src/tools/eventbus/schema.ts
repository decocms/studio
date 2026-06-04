/**
 * Event Bus Schemas
 *
 * Re-exports schemas from @decocms/bindings for use in MCP tools.
 * The bindings package is the source of truth for these schemas.
 */

import { z } from "zod";

// Re-export schemas from bindings package
export {
  // Publish schemas
  EventPublishInputSchema as PublishEventInputSchema,
  type EventPublishInput as PublishEventInput,
  EventPublishOutputSchema as PublishEventOutputSchema,
  type EventPublishOutput as PublishEventOutput,
  // Subscribe schemas
  EventSubscribeInputSchema as SubscribeInputSchema,
  type EventSubscribeInput as SubscribeInput,
  EventSubscribeOutputSchema as SubscribeOutputSchema,
  type EventSubscribeOutput as SubscribeOutput,
  // Unsubscribe schemas
  EventUnsubscribeInputSchema as UnsubscribeInputSchema,
  type EventUnsubscribeInput as UnsubscribeInput,
  EventUnsubscribeOutputSchema as UnsubscribeOutputSchema,
  type EventUnsubscribeOutput as UnsubscribeOutput,
  // Cancel schemas
  EventCancelInputSchema as CancelEventInputSchema,
  type EventCancelInput as CancelEventInput,
  EventCancelOutputSchema as CancelEventOutputSchema,
  type EventCancelOutput as CancelEventOutput,
  // Ack schemas
  EventAckInputSchema as AckEventInputSchema,
  type EventAckInput as AckEventInput,
  EventAckOutputSchema as AckEventOutputSchema,
  type EventAckOutput as AckEventOutput,
  // Sync subscriptions schemas
  EventSyncSubscriptionsInputSchema as SyncSubscriptionsInputSchema,
  type EventSyncSubscriptionsInput as SyncSubscriptionsInput,
  EventSyncSubscriptionsOutputSchema as SyncSubscriptionsOutputSchema,
  type EventSyncSubscriptionsOutput as SyncSubscriptionsOutput,
} from "@decocms/bindings";

// ============================================================================
// List Subscriptions Schemas (not part of binding, only for management API)
// ============================================================================

/**
 * Input schema for listing subscriptions
 */
export const ListSubscriptionsInputSchema = z.object({
  /** Optional: Filter by connection ID */
  connectionId: z
    .string()
    .optional()
    .describe("Filter subscriptions by connection ID (optional)"),
});

export type ListSubscriptionsInput = z.infer<
  typeof ListSubscriptionsInputSchema
>;

/**
 * Subscription entity schema (used for response mapping)
 */
const SubscriptionEntitySchema = z.object({
  /** Subscription ID */
  id: z.string().describe("Subscription ID"),

  /** Subscriber connection ID */
  connectionId: z.string().describe("Subscriber connection ID"),

  /** Event type pattern */
  eventType: z.string().describe("Event type pattern"),

  /** Publisher connection filter */
  publisher: z
    .string()
    .nullable()
    .describe("Publisher connection filter (null = all publishers)"),

  /** JSONPath filter */
  filter: z.string().nullable().describe("JSONPath filter expression"),

  /** Whether subscription is enabled */
  enabled: z.boolean().describe("Whether subscription is enabled"),

  /** Created timestamp */
  createdAt: z.string().datetime().describe("Created timestamp (ISO 8601)"),

  /** Updated timestamp */
  updatedAt: z.string().datetime().describe("Updated timestamp (ISO 8601)"),
});


/**
 * Output schema for listing subscriptions
 */
export const ListSubscriptionsOutputSchema = z.object({
  /** List of subscriptions */
  subscriptions: z
    .array(SubscriptionEntitySchema)
    .describe("List of subscriptions"),
});

export type ListSubscriptionsOutput = z.infer<
  typeof ListSubscriptionsOutputSchema
>;
