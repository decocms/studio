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
 * Seed the common users + organizations that several storage tests
 * implicitly depend on (matches the PGlite-era `seedCommonTestFixtures`
 * shape, with the difference that `emailVerified` is the BOOLEAN that real
 * Postgres expects — PGlite happened to tolerate `0`).
 *
 * Call this from a test's `beforeAll` after `resetTestPgDatabase`. If a
 * test only needs its own bespoke seed, skip this helper entirely.
 */
export async function seedCommonTestPgFixtures(
  database: MeshDatabase,
): Promise<void> {
  const now = new Date().toISOString();
  for (const userId of ["user_1", "user_123", "user_test", "test_user"]) {
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${userId + "@test.com"}, false, ${"Test " + userId}, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
  }
  for (const orgId of ["org_1", "org_123", "org_456", "org_test"]) {
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
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
