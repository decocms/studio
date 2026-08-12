import { type Kysely, sql } from "kysely";

/**
 * Per-org GitHub repo → org-fs volume sync configs.
 *
 * The public skill sets sync deployment-global repos (env-configured) into
 * shared `public-*` volumes. This table is the per-org counterpart: an org
 * member picks a repo-scoped `mcp-github` connection and a target volume, and
 * the org-repo-sync cron keeps that volume mirroring the repo — private repos
 * included, since the sync mints an installation token from the connection.
 *
 * `connection_id` cascades: deleting the repo connection removes the sync
 * config with it (the sync could never mint a token again anyway).
 * `repo_owner`/`repo_name` are denormalized from the connection's repoScope
 * metadata at create time so the cron and UI never re-parse connection JSON.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE org_repo_sync (
      id text PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      repo_owner text NOT NULL,
      repo_name text NOT NULL,
      ref text NOT NULL DEFAULT 'main',
      paths jsonb NOT NULL DEFAULT '[{"from":""}]',
      volume text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      last_synced_at timestamptz,
      last_sync_error text,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, volume)
    )
  `.execute(db);

  // The cron's work list and the per-org mount/catalog lookup: enabled rows only.
  await sql`
    CREATE INDEX idx_org_repo_sync_enabled
      ON org_repo_sync (organization_id)
      WHERE enabled
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS org_repo_sync`.execute(db);
}
