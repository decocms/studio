/**
 * Database Migration Runner
 *
 * Runs migrations in two phases:
 * 1. Better Auth migrations (if not skipped)
 * 2. Core Kysely migrations (numbered 001-xxx)
 *
 * Before the core migrator runs, legacy plugin-migration rows are swept out of
 * `kysely_migration` into a standalone `plugin_migrations` table. The plugin
 * system itself was removed; this sweep only keeps Kysely's strict
 * missing-migration check from choking on databases that were provisioned while
 * the plugin system was still live.
 */

import { Migrator, sql, type Kysely } from "kysely";
import migrations from "../../migrations";
import { migrateBetterAuth } from "../auth/migrate";
import { closeDatabase, getDb, type StudioDatabase } from "./index";
import type { Database } from "../storage/types";

// ============================================================================
// Legacy Plugin Migration Cleanup
// ============================================================================

/**
 * Check if a table exists in the database
 */
async function tableExists(
  db: Kysely<Database>,
  tableName: string,
): Promise<boolean> {
  const result = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${tableName}
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * Create the plugin_migrations table if it doesn't exist
 */
async function ensurePluginMigrationsTable(
  db: Kysely<Database>,
): Promise<void> {
  if (await tableExists(db, "plugin_migrations")) {
    return;
  }

  await sql`
    CREATE TABLE plugin_migrations (
      plugin_id TEXT NOT NULL,
      name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (plugin_id, name)
    )
  `.execute(db);
}

/**
 * Migrate existing plugin migrations from kysely_migration to plugin_migrations.
 *
 * This handles databases that had plugin migrations in Kysely's table with
 * various naming schemes (e.g., "pluginId/001-xxx", "~plugins/pluginId/001-xxx",
 * "999~plugins/pluginId/001-xxx").
 */
async function migrateExistingPluginRecords(
  db: Kysely<Database>,
): Promise<void> {
  if (!(await tableExists(db, "kysely_migration"))) {
    return; // Fresh database
  }

  // Find plugin migrations in kysely_migration table using various old formats
  const oldRecords = await sql<{ name: string; timestamp: string }>`
    SELECT name, timestamp FROM kysely_migration 
    WHERE name LIKE '%/%'
  `.execute(db);

  if (oldRecords.rows.length === 0) {
    return; // No plugin migrations to migrate
  }

  // Silently migrate old plugin records to the new system

  for (const { name, timestamp } of oldRecords.rows) {
    // Extract plugin ID and migration name from various formats:
    // - "pluginId/001-xxx"
    // - "~plugins/pluginId/001-xxx"
    // - "999~plugins/pluginId/001-xxx"
    let pluginPart = name;

    // Strip any prefix before ~plugins/
    if (name.includes("~plugins/")) {
      pluginPart = name.substring(
        name.indexOf("~plugins/") + "~plugins/".length,
      );
    }

    // Now pluginPart is "pluginId/migrationName"
    const slashIndex = pluginPart.indexOf("/");
    if (slashIndex === -1) {
      console.warn(`Skipping malformed plugin migration: ${name}`);
      continue;
    }

    const pluginId = pluginPart.substring(0, slashIndex);
    const migrationName = pluginPart.substring(slashIndex + 1);

    // Insert into new table and remove from old table only if new table has the record
    try {
      await sql`
        INSERT INTO plugin_migrations (plugin_id, name, timestamp)
        VALUES (${pluginId}, ${migrationName}, ${timestamp})
      `.execute(db);
      // Record migrated successfully
    } catch {
      // INSERT failed - could be duplicate key or other error
      // Verify record exists in new table before proceeding
      const exists = await sql<{ cnt: number }>`
        SELECT COUNT(*) as cnt FROM plugin_migrations 
        WHERE plugin_id = ${pluginId} AND name = ${migrationName}
      `.execute(db);

      if (Number(exists.rows[0]?.cnt) === 0) {
        // Record doesn't exist in new table - INSERT failed for unexpected reason
        console.warn(
          `Failed to migrate ${pluginId}/${migrationName}, keeping in old table`,
        );
        continue;
      }
      // Record exists in new table (was already migrated)
    }

    // Safe to remove from kysely_migration - record is confirmed in plugin_migrations
    await sql`
      DELETE FROM kysely_migration WHERE name = ${name}
    `.execute(db);
  }
}

// ============================================================================
// Core Migration System
// ============================================================================

/**
 * Migration options
 */
export interface MigrateOptions {
  /**
   * Keep the database connection open after migrations.
   * Set to true when running migrations before starting a server.
   * Default: false (closes connection after migrations)
   */
  keepOpen?: boolean;

  /**
   * Custom database instance to migrate.
   * If not provided, uses the global database from getDb().
   * When provided, Better Auth migrations are skipped (they use their own connection).
   */
  database?: StudioDatabase;

  /**
   * Skip Better Auth migrations.
   * Useful when providing a custom database that doesn't need Better Auth tables.
   * Default: false
   */
  skipBetterAuth?: boolean;
}

/**
 * Run Kysely migrations on a specific database instance
 */
export async function runKyselyMigrations(
  db: Kysely<Database>,
): Promise<number> {
  // IMPORTANT: Clean up plugin migrations from kysely_migration BEFORE running
  // Kysely's migrator. Kysely checks for missing migrations at startup and will
  // fail if it finds records like "user-sandbox/001-user-sandbox" that aren't
  // in the migrations list.
  await ensurePluginMigrationsTable(db);
  await migrateExistingPluginRecords(db);

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });

  const { error, results } = await migrator.migrateToLatest();

  let executed = 0;
  results?.forEach((it) => {
    if (it.status === "Success") {
      executed++;
    } else if (it.status === "Error") {
      console.error(`Failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error("Failed to migrate");
    console.error(error);
    throw error;
  }

  return executed;
}

/**
 * Migration result
 */
export interface MigrateResult {
  betterAuth: string;
  kysely: number;
}

/**
 * Run all pending migrations
 */
export async function migrateToLatest(
  options?: MigrateOptions,
): Promise<MigrateResult> {
  const {
    keepOpen = false,
    database: customDb,
    skipBetterAuth = false,
  } = options ?? {};

  // Run Better Auth migrations (unless skipped or using custom db)
  let betterAuth = "skipped";
  if (!skipBetterAuth && !customDb) {
    betterAuth = await migrateBetterAuth();
  }

  // Get database instance
  const database = customDb ?? getDb();

  // Helper to close database if needed
  const maybeCloseDatabase = async () => {
    if (!keepOpen && !customDb) {
      await closeDatabase(database).catch((err: unknown) => {
        console.warn("Warning: Error closing database:", err);
      });
    }
  };

  try {
    const kysely = await runKyselyMigrations(database.db);

    // Close database on success if needed
    await maybeCloseDatabase();

    return { betterAuth, kysely };
  } catch (error) {
    // Ensure database is closed on failure
    await maybeCloseDatabase();
    throw error;
  }
}

/**
 * Rollback the last migration
 */
export async function migrateDown(): Promise<void> {
  const database = getDb();

  const migrator = new Migrator({
    db: database.db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });

  const { error, results } = await migrator.migrateDown();

  results?.forEach((it) => {
    if (it.status === "Success") {
      console.log(
        `✅ Migration "${it.migrationName}" rolled back successfully`,
      );
    } else if (it.status === "Error") {
      console.error(`❌ Failed to rollback migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error("Failed to rollback migration");
    console.error(error);
    throw error;
  }
}

// Entry point: Run migrations when executed directly
if (import.meta.main) {
  (async () => {
    try {
      await migrateToLatest();
      console.log("Migrations completed.");
      process.exit(0);
    } catch (error) {
      console.error("Migration failed:", error);
      process.exit(1);
    }
  })();
}
