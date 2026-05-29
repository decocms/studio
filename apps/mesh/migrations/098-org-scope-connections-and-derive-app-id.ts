/**
 * Migration 098: org-scope existing connections + backfill synthetic app_ids.
 *
 * Companion to the private-connections model:
 *   1. Reset every existing connection to access='org'. This dissolves the
 *      "private connection hard-bound as a concrete child" case in existing
 *      data — afterward every concrete child is org-scoped and rule-conformant.
 *   2. Backfill a synthetic app_id (deriveAppId) for non-VIRTUAL rows that lack
 *      one. Because every row is org-scoped after step 1, the partial unique
 *      index idx_connections_user_app_unique (WHERE access='user') does not
 *      apply, so duplicate derived ids cannot collide here.
 *
 * The DB default for connections.access stays 'user' (migration 097), so newly
 * created connections remain private-by-default; this migration only resets
 * existing data.
 *
 * Spec: docs/superpowers/specs/2026-05-28-org-scoped-agents-typed-connections-design.md
 */

import { sql, type Kysely } from "kysely";
import { deriveAppId } from "../src/storage/derive-app-id";

interface ConnRow {
  id: string;
  connection_type: string;
  connection_url: string | null;
  connection_headers: string | null;
  app_id: string | null;
}

export async function flipAllConnectionsToOrg(
  db: Kysely<unknown>,
): Promise<void> {
  await sql`UPDATE connections SET access = 'org' WHERE access = 'user'`.execute(
    db,
  );
}

export async function backfillConnectionAppIds(
  db: Kysely<unknown>,
): Promise<void> {
  const result = (await sql<ConnRow>`
    SELECT id, connection_type, connection_url, connection_headers, app_id
    FROM connections
    WHERE app_id IS NULL AND connection_type <> 'VIRTUAL'
  `.execute(db)) as unknown as { rows: ConnRow[] };

  for (const row of result.rows) {
    const appId = deriveAppId({
      connection_type: row.connection_type,
      connection_url: row.connection_url,
      connection_headers: row.connection_headers,
      app_id: row.app_id,
    });
    if (appId) {
      await sql`UPDATE connections SET app_id = ${appId} WHERE id = ${row.id}`.execute(
        db,
      );
    }
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await flipAllConnectionsToOrg(db);
  await backfillConnectionAppIds(db);
}

export async function down(): Promise<void> {
  // One-time data migration: prior null app_ids and per-row access values
  // cannot be reliably reconstructed, so down() is a no-op.
}
