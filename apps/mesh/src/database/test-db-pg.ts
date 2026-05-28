/**
 * Real-Postgres test database connector for storage-layer tests.
 *
 * Storage tests that previously used `createTestDatabase()` (PGlite, WASM)
 * should use this helper instead — PGlite is Postgres-compatible at the SQL
 * surface but the query planner, indexes, RETURNING/ON CONFLICT semantics,
 * advisory locks, LISTEN/NOTIFY, and extension behavior all diverge from
 * real Postgres. A test that passes against PGlite can still fail in prod.
 *
 * Tests using this helper must run in the `Storage Integration` workflow
 * (.github/workflows/storage-integration.yml), which boots `postgres:16`
 * as a service and runs all migrations before tests start. Locally:
 *
 *   docker run -d --name pg -p 5432:5432 \
 *     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
 *     postgres:16
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun run --cwd=apps/mesh migrate
 *   DATABASE_URL=... bun test apps/mesh/src/storage/some.test.ts
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import type { MeshDatabase } from "./index";

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres";

/**
 * Connect to the real Postgres test database. Honors `DATABASE_URL` first,
 * falls back to the standard local-dev shape.
 */
export async function connectTestPgDatabase(): Promise<MeshDatabase> {
  const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString });
  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect });
  return { type: "postgres", db, pool };
}

/**
 * Close the test database, releasing the connection pool.
 */
export async function closeTestPgDatabase(
  database: MeshDatabase,
): Promise<void> {
  await database.db.destroy();
  if (!database.pool.ended) {
    await database.pool.end();
  }
}

/**
 * Truncate every user table in the `public` schema so the next test starts
 * from a clean slate. Preserves migrations (and the migrations bookkeeping
 * table) so we don't need to re-run them between tests.
 *
 * The list is computed at runtime via `pg_tables` rather than hardcoded —
 * adding a migration that introduces a new table doesn't require us to
 * remember to update a cleanup list.
 */
export async function resetTestPgDatabase(
  database: MeshDatabase,
): Promise<void> {
  const result = await sql<{
    tablename: string;
  }>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')
  `.execute(database.db);
  if (result.rows.length === 0) return;
  const list = result.rows.map((r) => `"${r.tablename}"`).join(", ");
  // CASCADE handles FK chains; one statement keeps it fast.
  await sql
    .raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
    .execute(database.db);
}
