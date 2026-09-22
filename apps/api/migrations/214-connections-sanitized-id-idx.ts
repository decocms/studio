/**
 * Expression index on `replace(id, '-', '_')` for `connections`.
 *
 * `ConnectionStorage.findBySanitizedId` (see `storage/connection.ts`) runs on
 * every `CREATE_CONNECTION` call, across ALL organizations, to catch two
 * connections whose `DATABASES_RUN_SQL` hyphen-fold would collide. Without an
 * index matching that same expression, Postgres can't use `id`'s primary-key
 * index — the `replace(...)` wrapper makes it a full table scan on every
 * connection creation, repo-wide.
 */
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idx_connections_sanitized_id ON connections (replace(id, '-', '_'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_connections_sanitized_id`.execute(db);
}
