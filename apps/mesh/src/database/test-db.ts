/**
 * Test-only database factory using PGlite for in-memory test isolation.
 *
 * Runtime code uses PostgreSQL exclusively. This module is only for tests.
 */

import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import type { MeshDatabase } from "./index";

export interface TestDatabase extends MeshDatabase {
  pglite: PGlite;
}

/**
 * Create an in-memory PGlite-backed MeshDatabase for tests.
 *
 * Returns a MeshDatabase with type "postgres" so it's compatible with all
 * runtime code. The `pool` field is a dummy Pool that should not be used
 * directly — tests that need LISTEN/NOTIFY should use real PostgreSQL.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const dialect = new KyselyPGlite(pglite).dialect;
  const db = new Kysely<DatabaseSchema>({ dialect });

  // Create a dummy pool — PGlite doesn't use pg.Pool but the type requires it
  const pool = new Pool({
    connectionString: "postgresql://test:test@localhost:5432/test",
  });
  // Immediately end the dummy pool so it doesn't try to connect
  pool.end();

  return { type: "postgres", db, pool, pglite };
}

/**
 * Close a test database, ensuring PGlite WASM resources are properly released.
 */
export async function closeTestDatabase(database: TestDatabase): Promise<void> {
  await database.db.destroy();
  if (database.pglite && !database.pglite.closed) {
    await database.pglite.close();
  }
  if (!database.pool.ended) {
    await database.pool.end();
  }
}
