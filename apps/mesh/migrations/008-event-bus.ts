/**
 * Event Bus Tables Migration
 *
 * Creates the events and subscriptions tables for the Deco Studio event bus.
 * - events: Stores CloudEvents with delivery status tracking and cron support
 * - event_subscriptions: Links subscriber connections to event type patterns
 * - event_deliveries: Tracks per-subscription delivery status with retry support
 *
 * Events follow the CloudEvents v1.0 specification.
 * @see https://cloudevents.io/
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create events table
  // Stores CloudEvents with delivery status for at-least-once delivery
  await db.schema
    .createTable("events")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When organization is deleted, events are automatically removed
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // CloudEvent required attributes
    .addColumn("type", "text", (col) => col.notNull()) // Event type (e.g., "order.created")
    .addColumn("source", "text", (col) => col.notNull()) // Connection ID of publisher
    .addColumn("specversion", "text", (col) => col.notNull().defaultTo("1.0"))
    // CloudEvent optional attributes
    .addColumn("subject", "text") // Resource identifier
    .addColumn("time", "text", (col) => col.notNull()) // ISO 8601 timestamp
    .addColumn("datacontenttype", "text", (col) =>
      col.notNull().defaultTo("application/json"),
    )
    .addColumn("dataschema", "text") // Schema URI
    .addColumn("data", "text") // JSON payload stored as text
    // Recurring event support
    .addColumn("cron", "varchar(255)") // Cron expression for recurring delivery
    // Delivery tracking
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending")) // pending, processing, delivered, failed
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text") // Last delivery error message
    .addColumn("next_retry_at", "text") // ISO 8601 timestamp for next retry
    // Audit fields
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Create subscriptions table
  // Links subscriber connections to event type patterns
  await db.schema
    .createTable("event_subscriptions")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When organization is deleted, subscriptions are automatically removed
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // Subscriber connection (who receives events)
    // CASCADE DELETE: When connection is deleted, subscriptions are automatically removed
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    // Filter by publisher connection (nullable = wildcard, matches all sources)
    .addColumn("publisher", "text")
    // Event type pattern to match (required)
    .addColumn("event_type", "text", (col) => col.notNull())
    // Optional JSONPath filter expression on event data
    .addColumn("filter", "text")
    // Subscription status
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1)) // SQLite boolean
    // Audit fields
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Create event_deliveries table to track per-subscription delivery status
  // This enables tracking which subscriptions have received which events
  await db.schema
    .createTable("event_deliveries")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("event_id", "text", (col) => col.notNull())
    // CASCADE DELETE: When subscription is deleted, deliveries are automatically removed
    .addColumn("subscription_id", "text", (col) =>
      col.notNull().references("event_subscriptions.id").onDelete("cascade"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending")) // pending, processing, delivered, failed
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("delivered_at", "text") // ISO 8601 timestamp
    .addColumn("next_retry_at", "text") // ISO 8601 timestamp for scheduled/retry
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Indexes for events table
  // Query by organization and status for worker polling
  await db.schema
    .createIndex("idx_events_org_status")
    .on("events")
    .columns(["organization_id", "status"])
    .execute();

  // Query by source connection
  await db.schema
    .createIndex("idx_events_source")
    .on("events")
    .columns(["source"])
    .execute();

  // Query by type for subscription matching
  await db.schema
    .createIndex("idx_events_type")
    .on("events")
    .columns(["type"])
    .execute();

  // Query pending events for retry
  await db.schema
    .createIndex("idx_events_retry")
    .on("events")
    .columns(["status", "next_retry_at"])
    .execute();

  // Indexes for subscriptions table
  // Query by subscriber connection
  await db.schema
    .createIndex("idx_subscriptions_connection")
    .on("event_subscriptions")
    .columns(["connection_id"])
    .execute();

  // Query by event type for matching
  await db.schema
    .createIndex("idx_subscriptions_type")
    .on("event_subscriptions")
    .columns(["event_type"])
    .execute();

  // Query by organization and enabled status
  await db.schema
    .createIndex("idx_subscriptions_org_enabled")
    .on("event_subscriptions")
    .columns(["organization_id", "enabled"])
    .execute();

  // Unique index for idempotent subscriptions
  // Ensures a connection can only have one subscription per event_type/source/filter combination
  await db.schema
    .createIndex("idx_subscriptions_unique")
    .on("event_subscriptions")
    .columns(["connection_id", "event_type", "publisher", "filter"])
    .unique()
    .execute();

  // Indexes for event_deliveries table
  // Query by event for delivery status
  await db.schema
    .createIndex("idx_deliveries_event")
    .on("event_deliveries")
    .columns(["event_id"])
    .execute();

  // Query pending deliveries for a subscription
  await db.schema
    .createIndex("idx_deliveries_subscription_status")
    .on("event_deliveries")
    .columns(["subscription_id", "status"])
    .execute();

  // Index for efficient retry/scheduled delivery polling
  await db.schema
    .createIndex("idx_deliveries_retry")
    .on("event_deliveries")
    .columns(["status", "next_retry_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("idx_deliveries_retry").execute();
  await db.schema.dropIndex("idx_deliveries_subscription_status").execute();
  await db.schema.dropIndex("idx_deliveries_event").execute();
  await db.schema.dropIndex("idx_subscriptions_unique").execute();
  await db.schema.dropIndex("idx_subscriptions_org_enabled").execute();
  await db.schema.dropIndex("idx_subscriptions_type").execute();
  await db.schema.dropIndex("idx_subscriptions_connection").execute();
  await db.schema.dropIndex("idx_events_retry").execute();
  await db.schema.dropIndex("idx_events_type").execute();
  await db.schema.dropIndex("idx_events_source").execute();
  await db.schema.dropIndex("idx_events_org_status").execute();

  // Drop tables in reverse order
  await db.schema.dropTable("event_deliveries").execute();
  await db.schema.dropTable("event_subscriptions").execute();
  await db.schema.dropTable("events").execute();
}
