/**
 * Migration 077: Trigger Callback Tokens — per subscription
 *
 * Each automation trigger now gets its own callback token row, so we can
 * disable a single subscription without invalidating its siblings on the
 * same connection. Adds `subscription_id` (= automation_triggers.id) and
 * relaxes the unique index from `(connection_id, organization_id)` to
 * `subscription_id` alone.
 *
 * Existing rows get backfilled with a placeholder subscription_id derived
 * from their primary key — they remain validatable until the next
 * trigger toggle, which writes a fresh row keyed by the real trigger id.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Add subscription_id, nullable initially so we can backfill.
  await db.schema
    .alterTable("trigger_callback_tokens")
    .addColumn("subscription_id", "text")
    .execute();

  // 2. Backfill: existing rows aren't tied to a specific trigger id, so
  //    use the row's own primary key as a self-referential placeholder.
  //    Not strictly correct, but keeps the rows queryable until the next
  //    TRIGGER_CONFIGURE replaces them with proper subscription ids.
  await sql`UPDATE trigger_callback_tokens SET subscription_id = id WHERE subscription_id IS NULL`.execute(
    db,
  );

  // 3. Make NOT NULL now that everything is populated.
  await db.schema
    .alterTable("trigger_callback_tokens")
    .alterColumn("subscription_id", (col) => col.setNotNull())
    .execute();

  // 4. Drop the old unique index that prevented multi-row.
  await db.schema
    .dropIndex("idx_trigger_callback_tokens_connection_org")
    .execute();

  // 5. New unique index on subscription_id — globally unique because
  //    automation trigger ids are uuids.
  await db.schema
    .createIndex("idx_trigger_callback_tokens_subscription")
    .on("trigger_callback_tokens")
    .columns(["subscription_id"])
    .unique()
    .execute();

  // 6. Keep a non-unique lookup index on (connection_id, organization_id)
  //    for fanout queries during trigger callback validation.
  await db.schema
    .createIndex("idx_trigger_callback_tokens_connection_org_lookup")
    .on("trigger_callback_tokens")
    .columns(["connection_id", "organization_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("idx_trigger_callback_tokens_connection_org_lookup")
    .execute();
  await db.schema
    .dropIndex("idx_trigger_callback_tokens_subscription")
    .execute();
  // Restore the original unique index. Note: this may fail if multi-row
  // data exists from the new code path — `down` is best-effort.
  await db.schema
    .createIndex("idx_trigger_callback_tokens_connection_org")
    .on("trigger_callback_tokens")
    .columns(["connection_id", "organization_id"])
    .unique()
    .execute();
  await db.schema
    .alterTable("trigger_callback_tokens")
    .dropColumn("subscription_id")
    .execute();
}
