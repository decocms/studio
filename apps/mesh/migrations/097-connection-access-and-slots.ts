/**
 * Migration 097: Connection access + agent slots.
 *
 * Adds the foundation for per-user connections and typed slots in agents.
 *
 * Changes:
 *   1. connections.access — 'user' | 'org'. Existing rows backfill to 'org'.
 *      New rows default to 'user' (private-by-default).
 *   2. connection_aggregations.slot_app_id — nullable text. When set,
 *      child_connection_id must be NULL (XOR enforced by CHECK).
 *      child_connection_id is relaxed to NULLABLE.
 *   3. Partial unique index (R4): one user-private connection per
 *      (organization, creator, app_id).
 *   4. Partial unique index: one slot per (agent, app_id).
 *
 * Spec: docs/superpowers/specs/2026-05-27-private-connections-design.md
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE connections
      ADD COLUMN access text NOT NULL DEFAULT 'org'
  `.execute(db);

  await sql`
    ALTER TABLE connections
      ADD CONSTRAINT connections_access_check
      CHECK (access IN ('user', 'org'))
  `.execute(db);

  await sql`
    ALTER TABLE connections
      ALTER COLUMN access SET DEFAULT 'user'
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_connections_user_app_unique
      ON connections (organization_id, created_by, app_id)
      WHERE access = 'user' AND app_id IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE connection_aggregations
      ADD COLUMN slot_app_id text
  `.execute(db);

  await sql`
    ALTER TABLE connection_aggregations
      ALTER COLUMN child_connection_id DROP NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE connection_aggregations
      ADD CONSTRAINT conn_agg_slot_xor
      CHECK (
        (child_connection_id IS NOT NULL AND slot_app_id IS NULL)
        OR
        (child_connection_id IS NULL AND slot_app_id IS NOT NULL)
      )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_conn_agg_slot_unique
      ON connection_aggregations (parent_connection_id, slot_app_id)
      WHERE slot_app_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_conn_agg_slot_unique`.execute(db);
  await sql`
    ALTER TABLE connection_aggregations
      DROP CONSTRAINT IF EXISTS conn_agg_slot_xor
  `.execute(db);
  await sql`
    ALTER TABLE connection_aggregations
      ALTER COLUMN child_connection_id SET NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE connection_aggregations
      DROP COLUMN IF EXISTS slot_app_id
  `.execute(db);

  await sql`DROP INDEX IF EXISTS idx_connections_user_app_unique`.execute(db);
  await sql`
    ALTER TABLE connections
      DROP CONSTRAINT IF EXISTS connections_access_check
  `.execute(db);
  await sql`
    ALTER TABLE connections
      DROP COLUMN IF EXISTS access
  `.execute(db);
}
