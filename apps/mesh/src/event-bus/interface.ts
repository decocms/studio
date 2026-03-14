/**
 * Event Bus Interface
 *
 * Defines the core interface for the event bus system.
 * Implementations handle event publishing, subscription management,
 * and background event delivery.
 */

import type { CloudEvent } from "@decocms/bindings";
import type {
  SyncSubscriptionsInput,
  SyncSubscriptionsResult,
} from "../storage/event-bus";
import type { Event, EventSubscription } from "../storage/types";

// ============================================================================
// Event Bus Types
// ============================================================================

/**
 * Input for publishing an event
 */
export interface PublishEventInput {
  /** Event type (e.g., "order.created") */
  type: string;
  /** Optional subject/resource identifier */
  subject?: string;
  /** Event payload (any JSON value) */
  data?: unknown;
  /**
   * Optional scheduled delivery time (ISO 8601 timestamp).
   * If provided, the event will not be delivered until this time.
   * If omitted, the event is delivered immediately.
   * Cannot be used together with `cron`.
   */
  deliverAt?: string;
  /**
   * Optional cron expression for recurring events.
   * If provided, the event will be delivered repeatedly according to the schedule.
   * Use cancelEvent to stop recurring deliveries.
   * Cannot be used together with `deliverAt`.
   */
  cron?: string;
}

/**
 * Input for subscribing to events
 */
export interface SubscribeInput {
  /** Connection ID that will receive events */
  connectionId: string;
  /** Event type pattern to match */
  eventType: string;
  /** Optional: Only receive events from this publisher connection */
  publisher?: string;
  /** Optional: JSONPath filter expression on event data */
  filter?: string;
}

/**
 * Event bus configuration
 */
export interface EventBusConfig {
  /** How often to poll for pending events (ms) - used as safety-net fallback */
  pollIntervalMs?: number;
  /** Maximum number of events to process per batch */
  batchSize?: number;
  /** Maximum number of delivery attempts before marking as failed */
  maxAttempts?: number;
  /** Base delay between retries (ms) - exponential backoff applied */
  retryDelayMs?: number;
  /** Maximum delay between retries (ms) - caps exponential backoff */
  maxDelayMs?: number;
}

/**
 * Default event bus configuration
 */
export const DEFAULT_EVENT_BUS_CONFIG: Required<EventBusConfig> = {
  pollIntervalMs: 5000, // 5 seconds
  batchSize: 100,
  maxAttempts: 20, // 20 attempts before marking as failed
  retryDelayMs: 1000, // 1 second base delay
  maxDelayMs: 3600000, // 1 hour max delay
};

// ============================================================================
// Event Bus Interface
// ============================================================================

/**
 * EventBus interface for publishing and subscribing to events
 *
 * Note: The interface is named IEventBus internally, but exported as EventBus
 * for backwards compatibility. Use `import type { EventBus }` for typing.
 */
export interface IEventBus {
  /**
   * Publish an event
   *
   * @param organizationId - Organization scope
   * @param publisherConnectionId - Connection ID of the publisher (from auth token)
   * @param input - Event data
   * @returns The created event
   */
  publish(
    organizationId: string,
    publisherConnectionId: string,
    input: PublishEventInput,
  ): Promise<Event>;

  /**
   * Subscribe a connection to events
   *
   * @param organizationId - Organization scope
   * @param input - Subscription configuration
   * @returns The created subscription
   */
  subscribe(
    organizationId: string,
    input: SubscribeInput,
  ): Promise<EventSubscription>;

  /**
   * Unsubscribe from events
   *
   * @param organizationId - Organization scope
   * @param subscriptionId - Subscription to remove
   * @returns Success status
   */
  unsubscribe(
    organizationId: string,
    subscriptionId: string,
  ): Promise<{ success: boolean }>;

  /**
   * List subscriptions
   *
   * @param organizationId - Organization scope
   * @param connectionId - Optional: filter by subscriber connection
   * @returns List of subscriptions
   */
  listSubscriptions(
    organizationId: string,
    connectionId?: string,
  ): Promise<EventSubscription[]>;

  /**
   * Get a subscription by ID
   *
   * @param organizationId - Organization scope
   * @param subscriptionId - Subscription ID
   * @returns Subscription or null if not found
   */
  getSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<EventSubscription | null>;

  /**
   * Get an event by ID
   *
   * @param organizationId - Organization scope
   * @param eventId - Event ID
   * @returns Event or null if not found
   */
  getEvent(organizationId: string, eventId: string): Promise<Event | null>;

  /**
   * Cancel a recurring event to stop future deliveries.
   * Only the publisher connection can cancel its own events.
   *
   * @param organizationId - Organization scope
   * @param eventId - Event to cancel
   * @param sourceConnectionId - Connection ID of the caller (for ownership verification)
   * @returns Success status
   */
  cancelEvent(
    organizationId: string,
    eventId: string,
    sourceConnectionId: string,
  ): Promise<{ success: boolean }>;

  /**
   * Acknowledge delivery of an event.
   * Used when subscriber returns retryAfter in ON_EVENTS response and later
   * calls EVENT_ACK to confirm successful processing.
   *
   * @param organizationId - Organization scope
   * @param eventId - Event to acknowledge
   * @param connectionId - Subscriber connection ID (from auth token)
   * @returns Success status
   */
  ackEvent(
    organizationId: string,
    eventId: string,
    connectionId: string,
  ): Promise<{ success: boolean }>;

  /**
   * Sync subscriptions to a desired state.
   * Creates new subscriptions, deletes removed ones, and updates filters.
   * Subscriptions are identified by (eventType, publisher).
   *
   * @param organizationId - Organization scope
   * @param input - Sync configuration with connectionId and desired subscriptions
   * @returns Summary of changes and current subscriptions
   */
  syncSubscriptions(
    organizationId: string,
    input: Omit<SyncSubscriptionsInput, "organizationId">,
  ): Promise<SyncSubscriptionsResult>;

  /**
   * Start the background worker for event delivery
   * Also resets any stuck deliveries from previous crashes
   */
  start(): void | Promise<void>;

  /**
   * Stop the background worker
   */
  stop(): void | Promise<void>;

  /**
   * Check if the worker is running
   */
  isRunning(): boolean;
}

/**
 * Per-event result from subscriber
 *
 * Three modes:
 * - `{ success: true }` - Event processed successfully
 * - `{ success: false, error: "..." }` - Event failed permanently
 * - `{ retryAfter: 60000 }` - Retry later (success not yet determined)
 */
export interface EventResult {
  success?: boolean;
  error?: string;
  retryAfter?: number;
}

/**
 * Notify subscriber callback type
 * Called by the worker to deliver events to subscribers
 *
 * Response options:
 * - Batch mode: success, error, retryAfter apply to all events
 * - Per-event mode: results map contains individual outcomes by event ID
 */
export type NotifySubscriberFn = (
  connectionId: string,
  events: CloudEvent[],
) => Promise<{
  success?: boolean;
  error?: string;
  retryAfter?: number;
  results?: Record<string, EventResult>;
}>;

/**
 * EventBus type alias for the interface
 * Use this for typing (e.g., in tests or function parameters)
 */
export type EventBus = IEventBus;
