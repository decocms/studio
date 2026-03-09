/**
 * Event Bus Storage
 *
 * Provides database operations for the event bus:
 * - Publishing events
 * - Managing subscriptions
 * - Tracking event deliveries
 *
 * Supports both PGlite and PostgreSQL via Kysely.
 *
 * Concurrency Safety:
 * - Uses atomic UPDATE with status change to claim deliveries
 * - Multiple workers can safely poll without processing same events
 */

import type { Kysely, Selectable } from "kysely";
import type {
  Database,
  Event,
  EventDelivery,
  EventSubscription,
  EventSubscriptionTable,
  EventStatus,
} from "./types";

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for creating a new event
 */
export interface CreateEventInput {
  id: string;
  organizationId: string;
  type: string;
  source: string;
  subject?: string | null;
  time: string;
  datacontenttype?: string;
  dataschema?: string | null;
  data?: unknown | null;
  cron?: string | null;
}

/**
 * Input for creating a subscription
 */
export interface CreateSubscriptionInput {
  id: string;
  organizationId: string;
  connectionId: string;
  publisher?: string | null;
  eventType: string;
  filter?: string | null;
}

/**
 * Pending event with matched subscriptions for delivery
 */
export interface PendingDelivery {
  delivery: EventDelivery;
  event: Event;
  subscription: EventSubscription;
}

/**
 * Input for syncing subscriptions
 */
export interface SyncSubscriptionsInput {
  organizationId: string;
  connectionId: string;
  subscriptions: Array<{
    eventType: string;
    publisher?: string | null;
    filter?: string | null;
  }>;
}

/**
 * Result of syncing subscriptions
 */
export interface SyncSubscriptionsResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  subscriptions: EventSubscription[];
}

// ============================================================================
// EventBusStorage Interface
// ============================================================================

/**
 * EventBusStorage provides database operations for the event bus
 */
export interface EventBusStorage {
  /**
   * Insert a new event with status=pending
   */
  publishEvent(input: CreateEventInput): Promise<Event>;

  /**
   * Create a new subscription
   */
  subscribe(input: CreateSubscriptionInput): Promise<EventSubscription>;

  /**
   * Delete a subscription by ID
   */
  unsubscribe(
    id: string,
    organizationId: string,
  ): Promise<{ success: boolean }>;

  /**
   * List subscriptions, optionally filtered by connection
   */
  listSubscriptions(
    organizationId: string,
    connectionId?: string,
  ): Promise<EventSubscription[]>;

  /**
   * Get a subscription by ID
   */
  getSubscription(
    id: string,
    organizationId: string,
  ): Promise<EventSubscription | null>;

  /**
   * Find subscriptions that match an event
   * Matches by event_type and optionally source_connection_id
   */
  getMatchingSubscriptions(event: Event): Promise<EventSubscription[]>;

  /**
   * Create delivery records for an event and its matching subscriptions
   *
   * @param eventId - The event ID
   * @param subscriptionIds - Subscription IDs to create deliveries for
   * @param deliverAt - Optional scheduled delivery time (ISO 8601). If provided, deliveries won't be processed until this time.
   */
  createDeliveries(
    eventId: string,
    subscriptionIds: string[],
    deliverAt?: string,
  ): Promise<void>;

  /**
   * Atomically claim pending deliveries for processing.
   * Uses an atomic UPDATE ... WHERE id IN (subquery) ... RETURNING clause
   * to change status from 'pending' to 'processing', ensuring only one
   * worker processes each delivery. Works with both PGlite and PostgreSQL.
   *
   * @param limit - Maximum number of deliveries to claim
   * @returns Claimed deliveries with their events and subscriptions
   */
  claimPendingDeliveries(limit: number): Promise<PendingDelivery[]>;

  /**
   * Mark deliveries as delivered (batch)
   * Changes status from 'processing' to 'delivered'
   */
  markDeliveriesDelivered(deliveryIds: string[]): Promise<void>;

  /**
   * Mark deliveries as failed with error message (batch)
   * Implements exponential backoff for retries
   *
   * @param deliveryIds - IDs of deliveries to mark
   * @param error - Error message
   * @param maxAttempts - Maximum delivery attempts before permanent failure
   * @param retryDelayMs - Base delay for exponential backoff (ms)
   * @param maxDelayMs - Maximum delay cap for backoff (ms)
   */
  markDeliveriesFailed(
    deliveryIds: string[],
    error: string,
    maxAttempts?: number,
    retryDelayMs?: number,
    maxDelayMs?: number,
  ): Promise<void>;

  /**
   * Update event status based on delivery states
   * If all deliveries are delivered, mark event as delivered
   * If any delivery has reached max attempts, mark as failed
   */
  updateEventStatus(eventId: string): Promise<void>;

  /**
   * Reset stuck deliveries that were in 'processing' state when server crashed.
   * Called on worker startup to recover from unexpected shutdowns.
   * @returns Number of deliveries reset
   */
  resetStuckDeliveries(): Promise<number>;

  /**
   * Get an event by ID
   */
  getEvent(eventId: string, organizationId: string): Promise<Event | null>;

  /**
   * Find an active cron event by type, source, and cron expression.
   * Used for idempotent cron event publishing.
   *
   * @param organizationId - Organization scope
   * @param type - Event type
   * @param source - Source connection ID
   * @param cron - Cron expression
   * @returns Existing active event or null
   */
  findActiveCronEvent(
    organizationId: string,
    type: string,
    source: string,
    cron: string,
  ): Promise<Event | null>;

  /**
   * Cancel a recurring event (sets status to 'failed' to stop future deliveries)
   * Only the publisher can cancel their own events.
   *
   * @param eventId - The event ID to cancel
   * @param organizationId - Organization scope
   * @param sourceConnectionId - Connection ID of the caller (for ownership verification)
   * @returns Success status
   */
  cancelEvent(
    eventId: string,
    organizationId: string,
    sourceConnectionId: string,
  ): Promise<{ success: boolean }>;

  /**
   * Schedule deliveries for retry without incrementing attempts.
   * Used when subscriber returns retryAfter - they want more time but it shouldn't
   * count toward the max attempts limit.
   *
   * @param deliveryIds - IDs of deliveries to reschedule
   * @param retryAfterMs - Milliseconds from now to retry
   */
  scheduleRetryWithoutAttemptIncrement(
    deliveryIds: string[],
    retryAfterMs: number,
  ): Promise<void>;

  /**
   * Acknowledge delivery of an event to a subscriber.
   * Used when subscriber returned retryAfter and later calls EVENT_ACK
   * to confirm successful processing.
   *
   * @param eventId - The event ID to acknowledge
   * @param organizationId - Organization scope (for security)
   * @param connectionId - The subscriber's connection ID
   * @returns Success status
   */
  ackDelivery(
    eventId: string,
    organizationId: string,
    connectionId: string,
  ): Promise<{ success: boolean }>;

  /**
   * Sync subscriptions to a desired state.
   * Creates new subscriptions, deletes removed ones, and updates filters.
   * Subscriptions are identified by (eventType, publisher) - only one per combination.
   *
   * @param input - Organization, connection, and desired subscriptions
   * @returns Summary of changes and current subscriptions
   */
  syncSubscriptions(
    input: SyncSubscriptionsInput,
  ): Promise<SyncSubscriptionsResult>;
}

// ============================================================================
// EventBusStorage Implementation
// ============================================================================

/**
 * Default EventBusStorage implementation using Kysely
 */
class KyselyEventBusStorage implements EventBusStorage {
  constructor(private db: Kysely<Database>) {}

  private mapRowToSubscription(
    row: Selectable<EventSubscriptionTable>,
  ): EventSubscription {
    return {
      id: row.id,
      organizationId: row.organization_id,
      connectionId: row.connection_id,
      publisher: row.publisher,
      eventType: row.event_type,
      filter: row.filter,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async publishEvent(input: CreateEventInput): Promise<Event> {
    const now = new Date().toISOString();

    await this.db
      .insertInto("events")
      .values({
        id: input.id,
        organization_id: input.organizationId,
        type: input.type,
        source: input.source,
        specversion: "1.0",
        subject: input.subject ?? null,
        time: input.time,
        datacontenttype: input.datacontenttype ?? "application/json",
        dataschema: input.dataschema ?? null,
        data: input.data ? JSON.stringify(input.data) : null,
        cron: input.cron ?? null,
        status: "pending",
        attempts: 0,
        last_error: null,
        next_retry_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return {
      id: input.id,
      organizationId: input.organizationId,
      type: input.type,
      source: input.source,
      specversion: "1.0",
      subject: input.subject ?? null,
      time: input.time,
      datacontenttype: input.datacontenttype ?? "application/json",
      dataschema: input.dataschema ?? null,
      data: input.data ?? null,
      cron: input.cron ?? null,
      status: "pending",
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async subscribe(input: CreateSubscriptionInput): Promise<EventSubscription> {
    // Check for existing subscription with same connection, event type, source, and filter
    // This makes subscription creation idempotent
    let query = this.db
      .selectFrom("event_subscriptions")
      .selectAll()
      .where("organization_id", "=", input.organizationId)
      .where("connection_id", "=", input.connectionId)
      .where("event_type", "=", input.eventType);

    // Handle nullable publisher comparison
    if (input.publisher) {
      query = query.where("publisher", "=", input.publisher);
    } else {
      query = query.where("publisher", "is", null);
    }

    // Handle nullable filter comparison
    if (input.filter) {
      query = query.where("filter", "=", input.filter);
    } else {
      query = query.where("filter", "is", null);
    }

    const existing = await query.executeTakeFirst();

    // If subscription already exists, return it (idempotent)
    if (existing) {
      return this.mapRowToSubscription(existing);
    }

    // Create new subscription
    const now = new Date().toISOString();

    await this.db
      .insertInto("event_subscriptions")
      .values({
        id: input.id,
        organization_id: input.organizationId,
        connection_id: input.connectionId,
        publisher: input.publisher ?? null,
        event_type: input.eventType,
        filter: input.filter ?? null,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return {
      id: input.id,
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      publisher: input.publisher ?? null,
      eventType: input.eventType,
      filter: input.filter ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  async unsubscribe(
    id: string,
    organizationId: string,
  ): Promise<{ success: boolean }> {
    const result = await this.db
      .deleteFrom("event_subscriptions")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return { success: (result.numDeletedRows ?? 0n) > 0n };
  }

  async listSubscriptions(
    organizationId: string,
    connectionId?: string,
  ): Promise<EventSubscription[]> {
    let query = this.db
      .selectFrom("event_subscriptions")
      .selectAll()
      .where("organization_id", "=", organizationId);

    if (connectionId) {
      query = query.where("connection_id", "=", connectionId);
    }

    const rows = await query.execute();

    return rows.map((row) => this.mapRowToSubscription(row));
  }

  async getSubscription(
    id: string,
    organizationId: string,
  ): Promise<EventSubscription | null> {
    const row = await this.db
      .selectFrom("event_subscriptions")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!row) return null;

    return this.mapRowToSubscription(row);
  }

  async getMatchingSubscriptions(event: Event): Promise<EventSubscription[]> {
    // Find enabled subscriptions that match the event type
    // and either have no publisher filter or match the event source
    const rows = await this.db
      .selectFrom("event_subscriptions")
      .selectAll()
      .where("organization_id", "=", event.organizationId)
      .where("enabled", "=", true)
      .where("event_type", "=", event.type)
      .where((eb) =>
        eb.or([
          eb("publisher", "is", null),
          eb("publisher", "=", event.source),
        ]),
      )
      .execute();

    return rows.map((row) => this.mapRowToSubscription(row));
  }

  async createDeliveries(
    eventId: string,
    subscriptionIds: string[],
    deliverAt?: string,
  ): Promise<void> {
    if (subscriptionIds.length === 0) return;

    const now = new Date().toISOString();

    // If deliverAt is provided, set next_retry_at to that time
    // The worker will only pick up deliveries where next_retry_at is null or in the past
    const nextRetryAt = deliverAt ?? null;

    const values = subscriptionIds.map((subscriptionId) => ({
      id: crypto.randomUUID(),
      event_id: eventId,
      subscription_id: subscriptionId,
      status: "pending" as EventStatus,
      attempts: 0,
      last_error: null,
      delivered_at: null,
      next_retry_at: nextRetryAt,
      created_at: now,
    }));

    await this.db.insertInto("event_deliveries").values(values).execute();
  }

  async claimPendingDeliveries(limit: number): Promise<PendingDelivery[]> {
    const now = new Date().toISOString();

    // Atomic claim with RETURNING — works with both PGlite and PostgreSQL
    const result = await this.db
      .updateTable("event_deliveries")
      .set({ status: "processing" })
      .where("id", "in", (eb) =>
        eb
          .selectFrom("event_deliveries as d")
          .innerJoin("event_subscriptions as s", "s.id", "d.subscription_id")
          .select("d.id")
          .where("d.status", "=", "pending")
          .where("s.enabled", "=", true)
          .where((inner) =>
            inner.or([
              inner("d.next_retry_at", "is", null),
              inner("d.next_retry_at", "<=", now),
            ]),
          )
          .orderBy("d.created_at", "asc")
          .limit(limit),
      )
      .where("status", "=", "pending")
      .returning(["id"])
      .execute();

    const claimedIds = result.map((r) => r.id);

    if (claimedIds.length === 0) {
      return [];
    }

    // Fetch the claimed deliveries with full details
    const rows = await this.db
      .selectFrom("event_deliveries as d")
      .innerJoin("events as e", "e.id", "d.event_id")
      .innerJoin("event_subscriptions as s", "s.id", "d.subscription_id")
      .select([
        // Delivery fields
        "d.id as delivery_id",
        "d.event_id",
        "d.subscription_id",
        "d.status as delivery_status",
        "d.attempts as delivery_attempts",
        "d.last_error as delivery_last_error",
        "d.delivered_at",
        "d.next_retry_at as delivery_next_retry_at",
        "d.created_at as delivery_created_at",
        // Event fields
        "e.organization_id",
        "e.type",
        "e.source",
        "e.specversion",
        "e.subject",
        "e.time",
        "e.datacontenttype",
        "e.dataschema",
        "e.data",
        "e.cron",
        "e.status as event_status",
        "e.attempts as event_attempts",
        "e.last_error as event_last_error",
        "e.next_retry_at",
        "e.created_at as event_created_at",
        "e.updated_at as event_updated_at",
        // Subscription fields
        "s.connection_id",
        "s.publisher",
        "s.event_type",
        "s.filter",
        "s.enabled",
        "s.created_at as subscription_created_at",
        "s.updated_at as subscription_updated_at",
      ])
      .where("d.id", "in", claimedIds)
      .where("d.status", "=", "processing")
      .execute();

    return rows.map((row) => ({
      delivery: {
        id: row.delivery_id,
        eventId: row.event_id,
        subscriptionId: row.subscription_id,
        status: row.delivery_status as EventStatus,
        attempts: row.delivery_attempts,
        lastError: row.delivery_last_error,
        deliveredAt: row.delivered_at,
        nextRetryAt: row.delivery_next_retry_at,
        createdAt: row.delivery_created_at,
      },
      event: {
        id: row.event_id,
        organizationId: row.organization_id,
        type: row.type,
        source: row.source,
        specversion: row.specversion,
        subject: row.subject,
        time: row.time,
        datacontenttype: row.datacontenttype,
        dataschema: row.dataschema,
        data: row.data ? JSON.parse(row.data as string) : null,
        cron: row.cron,
        status: row.event_status as EventStatus,
        attempts: row.event_attempts,
        lastError: row.event_last_error,
        nextRetryAt: row.next_retry_at,
        createdAt: row.event_created_at,
        updatedAt: row.event_updated_at,
      },
      subscription: {
        id: row.subscription_id,
        organizationId: row.organization_id,
        connectionId: row.connection_id,
        publisher: row.publisher,
        eventType: row.event_type,
        filter: row.filter,
        enabled: Boolean(row.enabled),
        createdAt: row.subscription_created_at,
        updatedAt: row.subscription_updated_at,
      },
    }));
  }

  async markDeliveriesDelivered(deliveryIds: string[]): Promise<void> {
    if (deliveryIds.length === 0) return;

    const now = new Date().toISOString();

    await this.db
      .updateTable("event_deliveries")
      .set({
        status: "delivered",
        delivered_at: now,
      })
      .where("id", "in", deliveryIds)
      .execute();
  }

  async markDeliveriesFailed(
    deliveryIds: string[],
    error: string,
    maxAttempts = 20,
    retryDelayMs = 1000,
    maxDelayMs = 3600000,
  ): Promise<void> {
    if (deliveryIds.length === 0) return;

    // Process each delivery individually to calculate exponential backoff
    for (const id of deliveryIds) {
      // Get current attempts
      const delivery = await this.db
        .selectFrom("event_deliveries")
        .select(["attempts"])
        .where("id", "=", id)
        .executeTakeFirst();

      if (!delivery) continue;

      const newAttempts = delivery.attempts + 1;

      if (newAttempts >= maxAttempts) {
        // Max attempts reached - mark as permanently failed
        await this.db
          .updateTable("event_deliveries")
          .set({
            attempts: newAttempts,
            last_error: error,
            status: "failed",
            next_retry_at: null,
          })
          .where("id", "=", id)
          .execute();
      } else {
        // Calculate exponential backoff: delay = retryDelayMs * 2^(attempts-1)
        // Cap at maxDelayMs (default 1 hour)
        const backoffDelay = Math.min(
          retryDelayMs * Math.pow(2, newAttempts - 1),
          maxDelayMs,
        );
        const nextRetryAt = new Date(Date.now() + backoffDelay).toISOString();

        await this.db
          .updateTable("event_deliveries")
          .set({
            attempts: newAttempts,
            last_error: error,
            status: "pending",
            next_retry_at: nextRetryAt,
          })
          .where("id", "=", id)
          .execute();
      }
    }
  }

  async updateEventStatus(eventId: string): Promise<void> {
    // Check if all deliveries are completed
    const deliveries = await this.db
      .selectFrom("event_deliveries")
      .select(["status"])
      .where("event_id", "=", eventId)
      .execute();

    if (deliveries.length === 0) return;

    const allDelivered = deliveries.every((d) => d.status === "delivered");
    const anyFailed = deliveries.some((d) => d.status === "failed");
    const hasInProgress = deliveries.some(
      (d) => d.status === "pending" || d.status === "processing",
    );

    if (allDelivered) {
      await this.db
        .updateTable("events")
        .set({
          status: "delivered",
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", eventId)
        .execute();
    } else if (anyFailed && !hasInProgress) {
      // Only mark as failed if no deliveries are still in progress
      await this.db
        .updateTable("events")
        .set({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", eventId)
        .execute();
    }
  }

  async resetStuckDeliveries(): Promise<number> {
    // Reset deliveries that were 'processing' when server crashed back to 'pending'
    // This ensures they will be retried on restart
    const result = await this.db
      .updateTable("event_deliveries")
      .set({ status: "pending" })
      .where("status", "=", "processing")
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  async getEvent(
    eventId: string,
    organizationId: string,
  ): Promise<Event | null> {
    const row = await this.db
      .selectFrom("events")
      .selectAll()
      .where("id", "=", eventId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organization_id,
      type: row.type,
      source: row.source,
      specversion: row.specversion,
      subject: row.subject,
      time: row.time,
      datacontenttype: row.datacontenttype,
      dataschema: row.dataschema,
      data: row.data ? JSON.parse(row.data as string) : null,
      cron: row.cron,
      status: row.status as EventStatus,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findActiveCronEvent(
    organizationId: string,
    type: string,
    source: string,
    cron: string,
  ): Promise<Event | null> {
    // Find an active cron event with matching type, source, and cron expression
    // Active means not failed/cancelled
    const row = await this.db
      .selectFrom("events")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("type", "=", type)
      .where("source", "=", source)
      .where("cron", "=", cron)
      .where("status", "in", ["pending", "processing", "delivered"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organization_id,
      type: row.type,
      source: row.source,
      specversion: row.specversion,
      subject: row.subject,
      time: row.time,
      datacontenttype: row.datacontenttype,
      dataschema: row.dataschema,
      data: row.data ? JSON.parse(row.data as string) : null,
      cron: row.cron,
      status: row.status as EventStatus,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async cancelEvent(
    eventId: string,
    organizationId: string,
    sourceConnectionId: string,
  ): Promise<{ success: boolean }> {
    // Only the publisher can cancel their own events
    const result = await this.db
      .updateTable("events")
      .set({
        status: "failed",
        last_error: "Cancelled by publisher",
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", eventId)
      .where("organization_id", "=", organizationId)
      .where("source", "=", sourceConnectionId) // Ownership check
      .where("status", "in", ["pending", "processing"]) // Only cancel active events
      .executeTakeFirst();

    // Also cancel any pending deliveries for this event
    if ((result.numUpdatedRows ?? 0n) > 0n) {
      await this.db
        .updateTable("event_deliveries")
        .set({
          status: "failed",
          last_error: "Event cancelled by publisher",
        })
        .where("event_id", "=", eventId)
        .where("status", "in", ["pending", "processing"])
        .execute();
    }

    return { success: (result.numUpdatedRows ?? 0n) > 0n };
  }

  async scheduleRetryWithoutAttemptIncrement(
    deliveryIds: string[],
    retryAfterMs: number,
  ): Promise<void> {
    if (deliveryIds.length === 0) return;

    const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();

    // Set status back to 'pending' with next_retry_at, but DON'T increment attempts
    // This is used when subscriber returns retryAfter - they want more time but
    // it shouldn't count toward the max attempts limit
    await this.db
      .updateTable("event_deliveries")
      .set({
        status: "pending",
        next_retry_at: nextRetryAt,
      })
      .where("id", "in", deliveryIds)
      .execute();
  }

  async ackDelivery(
    eventId: string,
    organizationId: string,
    connectionId: string,
  ): Promise<{ success: boolean }> {
    // First verify the event belongs to the organization (defense in depth)
    const event = await this.db
      .selectFrom("events")
      .select(["id"])
      .where("id", "=", eventId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!event) {
      return { success: false };
    }

    // Find deliveries for this event where the subscription belongs to the connection
    // and is in the same organization, then mark them as delivered
    const result = await this.db
      .updateTable("event_deliveries")
      .set({
        status: "delivered",
        delivered_at: new Date().toISOString(),
      })
      .where("event_id", "=", eventId)
      .where("status", "in", ["pending", "processing"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("event_subscriptions")
            .select("id")
            .whereRef(
              "event_subscriptions.id",
              "=",
              "event_deliveries.subscription_id",
            )
            .where("event_subscriptions.connection_id", "=", connectionId)
            .where("event_subscriptions.organization_id", "=", organizationId),
        ),
      )
      .executeTakeFirst();

    const updated = (result.numUpdatedRows ?? 0n) > 0n;

    // If we acked deliveries, update the event status
    if (updated) {
      await this.updateEventStatus(eventId);
    }

    return { success: updated };
  }

  async syncSubscriptions(
    input: SyncSubscriptionsInput,
  ): Promise<SyncSubscriptionsResult> {
    const { organizationId, connectionId, subscriptions: desired } = input;

    // Build a key for subscription identity: (eventType, publisher)
    const makeKey = (
      eventType: string,
      publisher: string | null | undefined,
    ): string => {
      return `${eventType}::${publisher ?? ""}`;
    };

    // Get current subscriptions for this connection
    const current = await this.listSubscriptions(organizationId, connectionId);

    // Build maps for efficient lookup
    const currentMap = new Map<string, EventSubscription>();
    for (const sub of current) {
      currentMap.set(makeKey(sub.eventType, sub.publisher), sub);
    }

    const desiredMap = new Map<
      string,
      { eventType: string; publisher?: string | null; filter?: string | null }
    >();
    for (const sub of desired) {
      desiredMap.set(makeKey(sub.eventType, sub.publisher), sub);
    }

    const now = new Date().toISOString();

    // Collect batch operations
    const toCreate: Array<{
      id: string;
      organization_id: string;
      connection_id: string;
      event_type: string;
      publisher: string | null;
      filter: string | null;
      enabled: boolean;
      created_at: string;
      updated_at: string;
    }> = [];
    const toUpdate: Array<{ id: string; filter: string | null }> = [];
    const toDelete: string[] = [];
    let unchanged = 0;

    // Process desired subscriptions: collect creates and updates
    for (const [key, desiredSub] of desiredMap) {
      const currentSub = currentMap.get(key);

      if (!currentSub) {
        // Collect for batch insert
        toCreate.push({
          id: crypto.randomUUID(),
          organization_id: organizationId,
          connection_id: connectionId,
          event_type: desiredSub.eventType,
          publisher: desiredSub.publisher ?? null,
          filter: desiredSub.filter ?? null,
          enabled: true,
          created_at: now,
          updated_at: now,
        });
      } else {
        // Check if filter needs update
        const currentFilter = currentSub.filter ?? null;
        const desiredFilter = desiredSub.filter ?? null;

        if (currentFilter !== desiredFilter) {
          toUpdate.push({ id: currentSub.id, filter: desiredFilter });
        } else {
          unchanged++;
        }
      }
    }

    // Collect subscriptions to delete (not in desired state)
    for (const [key, currentSub] of currentMap) {
      if (!desiredMap.has(key)) {
        toDelete.push(currentSub.id);
      }
    }

    // Execute batch insert
    if (toCreate.length > 0) {
      await this.db
        .insertInto("event_subscriptions")
        .values(toCreate)
        .execute();
    }

    // Execute batch updates (unfortunately Kysely doesn't support multi-row UPDATE in one query,
    // but we can at least run them concurrently)
    if (toUpdate.length > 0) {
      await Promise.all(
        toUpdate.map((u) =>
          this.db
            .updateTable("event_subscriptions")
            .set({
              filter: u.filter,
              updated_at: now,
            })
            .where("id", "=", u.id)
            .execute(),
        ),
      );
    }

    // Execute batch delete
    if (toDelete.length > 0) {
      await this.db
        .deleteFrom("event_subscriptions")
        .where("id", "in", toDelete)
        .execute();
    }

    const created = toCreate.length;
    const updated = toUpdate.length;
    const deleted = toDelete.length;

    // Fetch final state
    const finalSubscriptions = await this.listSubscriptions(
      organizationId,
      connectionId,
    );

    return {
      created,
      updated,
      deleted,
      unchanged,
      subscriptions: finalSubscriptions,
    };
  }
}

/**
 * Create an EventBusStorage instance
 */
export function createEventBusStorage(db: Kysely<Database>): EventBusStorage {
  return new KyselyEventBusStorage(db);
}
