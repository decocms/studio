/**
 * Database Migration Runner
 *
 * Runs migrations in three phases:
 * 1. Better Auth migrations (if not skipped)
 * 2. Core Kysely migrations (numbered 001-xxx)
 * 3. Plugin migrations (separate tracking table, runs after core)
 *
 * Plugin migrations use a separate `plugin_migrations` table to avoid
 * ordering conflicts with Kysely's strict alphabetical ordering.
 */

import { Migrator, sql, type Kysely } from "kysely";
import migrations from "../../migrations";
import { runSeed, type SeedName } from "../../migrations/seeds";
import { migrateBetterAuth } from "../auth/migrate";
import { collectPluginMigrations } from "../core/plugin-loader";
import { closeDatabase, getDb, type MeshDatabase } from "./index";
import type { Database } from "../storage/types";

export { runSeed, type SeedName };

// ============================================================================
// Plugin Migration System
// ============================================================================

/**
 * Check if a table exists in the database
 */
async function tableExists(
  db: Kysely<Database>,
  _dbType: "pglite" | "postgres",
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
  dbType: "pglite" | "postgres",
): Promise<void> {
  if (await tableExists(db, dbType, "plugin_migrations")) {
    return;
  }

  console.log("📦 Creating plugin_migrations table...");
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
  dbType: "pglite" | "postgres",
): Promise<void> {
  if (!(await tableExists(db, dbType, "kysely_migration"))) {
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

  console.log(
    `🔄 Migrating ${oldRecords.rows.length} plugin migration record(s) to new system...`,
  );

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
      console.warn(`   ⚠️  Skipping malformed plugin migration: ${name}`);
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
      console.log(`   Migrated: ${pluginId}/${migrationName}`);
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
          `   ⚠️  Failed to migrate ${pluginId}/${migrationName}, keeping in old table`,
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

/**
 * Run pending plugin migrations.
 *
 * Each plugin's migrations are tracked independently in the plugin_migrations table.
 * Migrations are run in order within each plugin (sorted by name).
 */
async function runPluginMigrations(db: Kysely<Database>): Promise<void> {
  const pluginMigrations = collectPluginMigrations();

  if (pluginMigrations.length === 0) {
    return; // No plugins with migrations
  }

  // Note: plugin_migrations table and old record migration are handled
  // in runKyselyMigrations() before Kysely's migrator runs

  // Get already executed migrations
  const executed = await sql<{ plugin_id: string; name: string }>`
    SELECT plugin_id, name FROM plugin_migrations
  `.execute(db);
  const executedSet = new Set(
    executed.rows.map((r) => `${r.plugin_id}/${r.name}`),
  );

  // Group migrations by plugin
  const migrationsByPlugin = new Map<
    string,
    Array<{
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      up: (db: any) => Promise<void>;
    }>
  >();

  for (const { pluginId, migration } of pluginMigrations) {
    if (!migrationsByPlugin.has(pluginId)) {
      migrationsByPlugin.set(pluginId, []);
    }
    migrationsByPlugin.get(pluginId)!.push({
      name: migration.name,
      up: migration.up,
    });
  }

  // Run pending migrations for each plugin
  let totalPending = 0;

  for (const [pluginId, pluginMigrationList] of migrationsByPlugin) {
    // Sort by name to ensure consistent order
    pluginMigrationList.sort((a, b) => a.name.localeCompare(b.name));

    for (const migration of pluginMigrationList) {
      const key = `${pluginId}/${migration.name}`;
      if (executedSet.has(key)) {
        continue; // Already executed
      }

      if (totalPending === 0) {
        console.log("🔌 Running plugin migrations...");
      }
      totalPending++;

      console.log(`   Running: ${key}`);
      await migration.up(db);

      // Record as executed
      const timestamp = new Date().toISOString();
      await sql`
        INSERT INTO plugin_migrations (plugin_id, name, timestamp)
        VALUES (${pluginId}, ${migration.name}, ${timestamp})
      `.execute(db);
    }
  }

  if (totalPending > 0) {
    console.log(`✅ ${totalPending} plugin migration(s) completed`);
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
  database?: MeshDatabase;

  /**
   * Skip Better Auth migrations.
   * Useful when providing a custom database that doesn't need Better Auth tables.
   * Default: false
   */
  skipBetterAuth?: boolean;

  /**
   * Seed to run after migrations.
   * Seeds populate the database with initial/test data.
   */
  seed?: SeedName;
}

/**
 * Run Kysely migrations on a specific database instance
 */
export async function runKyselyMigrations(
  db: Kysely<Database>,
  dbType: "pglite" | "postgres",
): Promise<void> {
  // IMPORTANT: Clean up plugin migrations from kysely_migration BEFORE running
  // Kysely's migrator. Kysely checks for missing migrations at startup and will
  // fail if it finds records like "user-sandbox/001-user-sandbox" that aren't
  // in the migrations list.
  await ensurePluginMigrationsTable(db, dbType);
  await migrateExistingPluginRecords(db, dbType);

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === "Success") {
      console.log(`✅ Migration "${it.migrationName}" executed successfully`);
    } else if (it.status === "Error") {
      console.error(`❌ Failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error("Failed to migrate");
    console.error(error);
    throw error;
  }
}

/**
 * Migration result with optional seed data
 */
export interface MigrateResult<T = unknown> {
  seedResult?: T;
}

/**
 * Run all pending migrations
 */
export async function migrateToLatest<T = unknown>(
  options?: MigrateOptions,
): Promise<MigrateResult<T>> {
  const {
    keepOpen = false,
    database: customDb,
    skipBetterAuth = false,
    seed,
  } = options ?? {};

  // Run Better Auth migrations (unless skipped or using custom db)
  if (!skipBetterAuth && !customDb) {
    await migrateBetterAuth();
  }

  // Get database instance
  const database = customDb ?? getDb();

  // Helper to close database if needed
  const maybeCloseDatabase = async () => {
    // Only close database connection if not keeping open for server
    // and we're using the global database (not a custom one)
    if (!keepOpen && !customDb) {
      console.log("🔒 Closing database connection...");
      await closeDatabase(database).catch((err: unknown) => {
        console.warn("Warning: Error closing database:", err);
      });
    }
  };

  try {
    // Phase 1: Run core Kysely migrations
    // (This also migrates any old plugin records from kysely_migration first)
    console.log("📊 Running Kysely migrations...");
    await runKyselyMigrations(database.db, database.type);
    console.log("🎉 Core migrations completed successfully");

    // Phase 2: Run plugin migrations (separate tracking)
    await runPluginMigrations(database.db);

    // Run seed if specified
    let seedResult: T | undefined;
    if (seed) {
      seedResult = await runSeed<T>(database.db, seed);
    }

    // Close database on success if needed
    await maybeCloseDatabase();

    return { seedResult };
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
  console.log("🚀 Migration script starting...");
  console.log("📦 Imported migrateToLatest function");

  (async () => {
    console.log("🏃 Executing migration function...");
    try {
      await migrateToLatest();
      console.log("✅ All migrations completed. Exiting...");
      process.exit(0);
    } catch (error) {
      console.error("❌ Migration failed:", error);
      process.exit(1);
    }
  })();
}
