/**
 * Add dependency_mode column to connection_aggregations
 *
 * This column tracks how a connection is related to a Virtual MCP:
 * - 'direct': User explicitly added this connection to the Virtual MCP
 * - 'indirect': Connection is referenced by virtual tool code (FK prevents deletion)
 *
 * Direct dependencies have their tools exposed in the Virtual MCP's tool list.
 * Indirect dependencies exist only to enforce FK constraints - their tools are
 * NOT exposed, but are called internally by virtual tool code.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add dependency_mode column with default 'direct' for existing rows
  // SQLite and PostgreSQL both support this syntax
  await sql`
    ALTER TABLE connection_aggregations 
    ADD COLUMN dependency_mode TEXT NOT NULL DEFAULT 'direct'
  `.execute(db);

  // Create index for efficient filtering by dependency_mode
  await db.schema
    .createIndex("idx_conn_agg_dependency_mode")
    .on("connection_aggregations")
    .columns(["parent_connection_id", "dependency_mode"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the index first
  await db.schema.dropIndex("idx_conn_agg_dependency_mode").execute();

  // Check if we're on PostgreSQL
  const isPostgres = await sql`SELECT current_database()`
    .execute(db)
    .then(() => true)
    .catch(() => false);

  if (isPostgres) {
    // PostgreSQL supports DROP COLUMN
    await sql`ALTER TABLE connection_aggregations DROP COLUMN dependency_mode`.execute(
      db,
    );
  } else {
    // SQLite doesn't support DROP COLUMN before 3.35.0
    // Need to recreate the table without the column

    // Drop existing indexes
    await db.schema.dropIndex("idx_conn_agg_unique").execute();
    await db.schema.dropIndex("idx_conn_agg_child").execute();
    await db.schema.dropIndex("idx_conn_agg_parent").execute();

    // Create new table without dependency_mode
    await db.schema
      .createTable("connection_aggregations_new")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("parent_connection_id", "text", (col) =>
        col.notNull().references("connections.id").onDelete("cascade"),
      )
      .addColumn("child_connection_id", "text", (col) =>
        col.notNull().references("connections.id").onDelete("restrict"),
      )
      .addColumn("selected_tools", "text")
      .addColumn("selected_resources", "text")
      .addColumn("selected_prompts", "text")
      .addColumn("created_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .execute();

    // Copy data (excluding dependency_mode)
    await sql`
      INSERT INTO connection_aggregations_new (
        id, parent_connection_id, child_connection_id,
        selected_tools, selected_resources, selected_prompts, created_at
      )
      SELECT
        id, parent_connection_id, child_connection_id,
        selected_tools, selected_resources, selected_prompts, created_at
      FROM connection_aggregations
    `.execute(db);

    // Drop old table and rename new table
    await db.schema.dropTable("connection_aggregations").execute();
    await db.schema
      .alterTable("connection_aggregations_new")
      .renameTo("connection_aggregations")
      .execute();

    // Recreate indexes
    await db.schema
      .createIndex("idx_conn_agg_parent")
      .on("connection_aggregations")
      .columns(["parent_connection_id"])
      .execute();

    await db.schema
      .createIndex("idx_conn_agg_child")
      .on("connection_aggregations")
      .columns(["child_connection_id"])
      .execute();

    await db.schema
      .createIndex("idx_conn_agg_unique")
      .on("connection_aggregations")
      .columns(["parent_connection_id", "child_connection_id"])
      .unique()
      .execute();
  }
}
