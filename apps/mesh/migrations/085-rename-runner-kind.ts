/**
 * Migration 080: Rename sandbox_runner_state.runner_kind →
 * sandbox_provider_kind, rewrite vmMap JSON keys in virtualmcps, and drop
 * threads.run_locally.
 *
 * (1) ALTER TABLE sandbox_runner_state RENAME COLUMN runner_kind TO
 *     sandbox_provider_kind — aligns the column name with the
 *     SandboxProviderKind type rename done in Task 1.1.
 *
 * (2) Walk every virtualmcps.metadata.vmMap[user][branch] entry and rename
 *     the JSON key `runnerKind` → `sandboxProviderKind`. The UPDATE is
 *     idempotent: it only rewrites entries where `runnerKind` exists and
 *     `sandboxProviderKind` does not, so re-running is safe.
 *
 * (3) DROP COLUMN threads.run_locally — the VM now owns runner-choice; the
 *     dispatch layer reads from VmMapEntry.sandboxProviderKind instead.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sandbox_runner_state
    RENAME COLUMN runner_kind TO sandbox_provider_kind
  `.execute(db);

  // Rewrite vmMap JSON keys. Wrapped in a DO block so it is a no-op in test
  // environments where the virtualmcps table was never created (PGlite
  // migration tests run in isolation and may not have the full schema).
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
                  WHEN entry ? 'runnerKind' AND NOT entry ? 'sandboxProviderKind'
                    THEN jsonb_set(entry, '{sandboxProviderKind}', entry->'runnerKind') - 'runnerKind'
                  ELSE entry
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

  await db.schema.alterTable("threads").dropColumn("run_locally").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-add threads.run_locally before the other reversals so that if
  // anything downstream reads the column it still exists.
  await db.schema
    .alterTable("threads")
    .addColumn("run_locally", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    ALTER TABLE sandbox_runner_state
    RENAME COLUMN sandbox_provider_kind TO runner_kind
  `.execute(db);

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
                  WHEN entry ? 'sandboxProviderKind' AND NOT entry ? 'runnerKind'
                    THEN jsonb_set(entry, '{runnerKind}', entry->'sandboxProviderKind') - 'sandboxProviderKind'
                  ELSE entry
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
