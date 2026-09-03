import { type Kysely, sql } from "kysely";

/**
 * A repo sync may now be backed by a first-class repository instead of a
 * repo-scoped `mcp-github` connection.
 *
 * Migration 201 added the nullable `repository_id` FK and backfilled it, but
 * `connection_id` stayed NOT NULL from migration 168, so a sync created from a
 * GitLab (or GitHub App) repository had nothing to put there. Drop the NOT
 * NULL and replace it with the real invariant: a sync needs at least one
 * credential source. Existing rows all carry a connection, so the constraint
 * validates without a rewrite of the data.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_repo_sync ALTER COLUMN connection_id DROP NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE org_repo_sync
      ADD CONSTRAINT org_repo_sync_source_present
      CHECK (connection_id IS NOT NULL OR repository_id IS NOT NULL)
  `.execute(db);
}

/** Repository-only rows have no connection to restore, so re-arming the NOT
 *  NULL of migration 168 means dropping them. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_repo_sync DROP CONSTRAINT IF EXISTS org_repo_sync_source_present
  `.execute(db);
  await sql`DELETE FROM org_repo_sync WHERE connection_id IS NULL`.execute(db);
  await sql`
    ALTER TABLE org_repo_sync ALTER COLUMN connection_id SET NOT NULL
  `.execute(db);
}
