/**
 * Migration 081: per-thread runner + harness pinning, and vmMap re-key.
 *
 * Adds:
 *   - `threads.sandbox_provider_kind` (nullable, backfilled on first message)
 *   - `threads.harness_id` (nullable, backfilled on first message)
 *
 * Re-keys `virtualmcps.metadata.vmMap` from 2-level to 3-level:
 *   vmMap[user][branch] = entry
 *   →
 *   vmMap[user][branch][entry.sandboxProviderKind ?? 'docker'] = entry
 * Idempotent: only re-keys entries that still have `vmId` at the second level
 * (which marks them as the 2-level legacy shape). The sandboxProviderKind
 * field stays on the entry for one release as a tolerant-reader fallback.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Thread columns (nullable; populated on first message by the
  //    POST /messages handler).
  await db.schema
    .alterTable("threads")
    .addColumn("sandbox_provider_kind", "text")
    .execute();
  await db.schema
    .alterTable("threads")
    .addColumn("harness_id", "text")
    .execute();

  // 2. vmMap re-key. Wrapped in a DO block so it no-ops if `virtualmcps`
  //    doesn't exist (PGlite test bootstrap order).
  await sql`
    DO $$ BEGIN
      UPDATE virtualmcps v
      SET metadata = jsonb_set(
        v.metadata,
        '{vmMap}',
        (
          SELECT jsonb_object_agg(
            user_key,
            (
              SELECT jsonb_object_agg(
                branch_key,
                CASE
                  -- Already 3-level (entry is itself a map without vmId): pass through.
                  WHEN NOT (entry ? 'vmId') THEN entry
                  -- Legacy 2-level: wrap under sandboxProviderKind.
                  ELSE jsonb_build_object(
                    COALESCE(entry->>'sandboxProviderKind', 'docker'),
                    entry
                  )
                END
              )
              FROM jsonb_each(user_map) AS branches(branch_key, entry)
            )
          )
          FROM jsonb_each(v.metadata->'vmMap') AS users(user_key, user_map)
        )
      )
      WHERE v.metadata ? 'vmMap'
        AND EXISTS (
          SELECT 1
          FROM jsonb_each(v.metadata->'vmMap') AS users(user_key, user_map)
          JOIN jsonb_each(user_map) AS branches(branch_key, entry) ON true
          WHERE entry ? 'vmId'
        );
    EXCEPTION WHEN undefined_table THEN
      -- PGlite migration order: virtualmcps not yet created. Safe no-op.
      NULL;
    END; $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the columns.
  await db.schema.alterTable("threads").dropColumn("harness_id").execute();
  await db.schema
    .alterTable("threads")
    .dropColumn("sandbox_provider_kind")
    .execute();

  // Reverse the vmMap re-key: collapse each (user, branch, kind) back to
  // (user, branch). When multiple kinds exist for the same branch, the first
  // one (in JSON iteration order) wins; the others are dropped. Acceptable
  // because down() is a manual recovery path, not a production rollback.
  await sql`
    DO $$ BEGIN
      UPDATE virtualmcps v
      SET metadata = jsonb_set(
        v.metadata,
        '{vmMap}',
        (
          SELECT jsonb_object_agg(
            user_key,
            (
              SELECT jsonb_object_agg(
                branch_key,
                CASE
                  -- Already 2-level (entry has vmId): pass through.
                  WHEN entry ? 'vmId' THEN entry
                  -- 3-level: pick the first kind's entry.
                  ELSE (
                    SELECT inner_entry
                    FROM jsonb_each(entry) AS kinds(kind_key, inner_entry)
                    LIMIT 1
                  )
                END
              )
              FROM jsonb_each(user_map) AS branches(branch_key, entry)
            )
          )
          FROM jsonb_each(v.metadata->'vmMap') AS users(user_key, user_map)
        )
      )
      WHERE v.metadata ? 'vmMap';
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END; $$
  `.execute(db);
}
