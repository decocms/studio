/**
 * Event Subscriber Well-Known Binding
 *
 * Defines the interface for MCP connections that can receive events.
 * Any MCP that implements this binding can receive batched CloudEvents
 * from the Deco Studio event bus.
 *
 * This binding includes:
 * - ON_EVENTS: Receive a batch of CloudEvents
 *
 * Events follow the CloudEvents v1.0 specification.
 * @see https://cloudevents.io/
 */

import { z } from "zod";
import { bindingClient, type ToolBinder } from "../core/binder";

/**
 * CloudEvent Schema
 *
 * Follows CloudEvents v1.0 specification.
 * Required attributes: id, source, type, specversion
 * Optional attributes: time, subject, datacontenttype, dataschema, data
 *
 * @see https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
 */
export const CloudEventSchema = z.object({
  /** CloudEvents specification version (always "1.0") */
  specversion: z.literal("1.0").describe("CloudEvents specification version"),

  /** Unique identifier for this event */
  id: z
    .string()
    .describe("Unique identifier for this event (UUID recommended)"),

  /**
   * Source of the event - in Deco Studio, this is the connection ID of the publisher.
   * Format: URI-reference identifying the context in which an event happened.
   */
  source: z.string().describe("Connection ID of the event publisher"),

  /**
   * Event type identifier.
   * Should be a reverse-DNS name like "com.example.order.created"
   */
  type: z
    .string()
    .describe("Event type (e.g., 'order.created', 'user.signup')"),

  /** Timestamp of when the event occurred (ISO 8601 format) */
  time: z
    .string()
    .datetime()
    .optional()
    .describe("Timestamp of when the event occurred (ISO 8601)"),

  /**
   * Subject of the event in the context of the event producer.
   * Can be used to identify the resource the event is about.
   */
  subject: z
    .string()
    .optional()
    .describe("Subject/resource identifier (e.g., order ID, user ID)"),

  /** Content type of the data attribute (e.g., "application/json") */
  datacontenttype: z
    .string()
    .optional()
    .default("application/json")
    .describe("Content type of the data attribute"),

  /** Schema URI for the data attribute */
  dataschema: z
    .string()
    .url()
    .optional()
    .describe("URI to the schema for the data attribute"),

  /** Event payload - can be any JSON value */
  data: z.unknown().optional().describe("Event payload (any JSON value)"),
});

/**
 * CloudEvent type - inferred from schema
 */
export type CloudEvent = z.infer<typeof CloudEventSchema>;

/**
 * ON_EVENTS Input Schema
 *
 * Accepts a batch of CloudEvents for processing.
 */
export const OnEventsInputSchema = z.object({
  /** Array of CloudEvents to process */
  events: z
    .array(CloudEventSchema)
    .min(1)
    .describe("Batch of CloudEvents to process"),
});

/**
 * ON_EVENTS Input type
 */
export type OnEventsInput = z.infer<typeof OnEventsInputSchema>;

/**
 * Per-event result schema
 * Allows granular control over each event in a batch
 *
 * Three modes:
 * - `{ success: true }` - Event processed successfully
 * - `{ success: false, error: "..." }` - Event failed permanently
 * - `{ retryAfter: 60000 }` - Retry later (success not yet determined)
 */
export const EventResultSchema = z.object({
  /** Whether this specific event was processed successfully */
  success: z
    .boolean()
    .optional()
    .describe("Whether this event was processed successfully"),

  /** Error message if success=false */
  error: z.string().optional().describe("Error message for this event"),

  /**
   * Request re-delivery of this event after this many milliseconds.
   * Does not count toward max retry attempts.
   * When present without success, indicates the event should be retried.
   */
  retryAfter: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Re-deliver this event after this many ms"),
});

/**
 * Per-event result type
 */
export type EventResult = z.infer<typeof EventResultSchema>;

/**
 * ON_EVENTS Output Schema
 *
 * Two modes of operation:
 *
 * 1. **Batch mode** (backward compatible): Use `success`, `error`, `retryAfter`
 *    to apply the same result to all events in the batch.
 *
 * 2. **Per-event mode**: Use `results` to specify individual outcomes for each event.
 *    Keys are event IDs, values are per-event results.
 *    Events not in `results` will use the batch-level fields as fallback.
 *
 * @example
 * // Batch mode - all events succeeded
 * { success: true }
 *
 * @example
 * // Per-event mode - mixed results
 * {
 *   results: {
 *     "event-1": { success: true },
 *     "event-2": { success: false, error: "Validation failed" },
 *     "event-3": { retryAfter: 60000 }
 *   }
 * }
 */
export const OnEventsOutputSchema = z.object({
  /** Batch-level success (applies to events not in `results`) */
  success: z
    .boolean()
    .optional()
    .describe("Batch success - applies to events not in results"),

  /** Batch-level error message */
  error: z
    .string()
    .optional()
    .describe("Batch error message - applies to events not in results"),

  /** Optional count of successfully processed events */
  processedCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of events successfully processed"),

  /**
   * Batch-level re-delivery request (applies to events not in `results`)
   */
  retryAfter: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Batch retryAfter - applies to events not in results"),

  /**
   * Per-event results, keyed by event ID.
   * Allows different handling for each event in the batch.
   * Events not specified here use batch-level fields as fallback.
   */
  results: z
    .record(z.string(), EventResultSchema)
    .optional()
    .describe("Per-event results keyed by event ID"),
});

/**
 * ON_EVENTS Output type
 */
export type OnEventsOutput = z.infer<typeof OnEventsOutputSchema>;

/**
 * Event Subscriber Binding
 *
 * Defines the interface for MCP connections that can receive events.
 * Implementations must provide the ON_EVENTS tool to receive batched CloudEvents.
 *
 * Required tools:
 * - ON_EVENTS: Receive and process a batch of CloudEvents
 */
export const EVENT_SUBSCRIBER_BINDING = [
  {
    name: "ON_EVENTS" as const,
    inputSchema: OnEventsInputSchema,
    outputSchema: OnEventsOutputSchema,
  },
] satisfies ToolBinder[];

/**
 * Event Subscriber Binding Client
 *
 * Use this to create a client for calling ON_EVENTS on subscriber connections.
 *
 * @example
 * ```typescript
 * import { EventSubscriberBinding } from "@decocms/bindings/event-subscriber";
 *
 * // For a connection
 * const client = EventSubscriberBinding.forConnection(connection);
 * const result = await client.ON_EVENTS({ events: [...] });
 *
 * // For an MCP client
 * const client = EventSubscriberBinding.forClient(mcpClient);
 * const result = await client.ON_EVENTS({ events: [...] });
 * ```
 */
export const EventSubscriberBinding = bindingClient(EVENT_SUBSCRIBER_BINDING);

/**
 * Type helper for the Event Subscriber binding client
 */
export type EventSubscriberBindingClient = ReturnType<
  typeof EventSubscriberBinding.forConnection
>;
