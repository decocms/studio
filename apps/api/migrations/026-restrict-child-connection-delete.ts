/**
 * Restrict Child Connection Deletion
 *
 * Changes the FK constraint on connection_aggregations.child_connection_id
 * from ON DELETE CASCADE to ON DELETE RESTRICT.
 *
 * This prevents users from deleting a connection that is being used
 * by a Virtual MCP (agent). They must first remove the connection from
 * the agent before deleting it.
 *
 * SQLite doesn't support ALTER CONSTRAINT, so we need to recreate the table.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Drop indexes on connection_aggregations
  // ============================================================================

  await db.schema.dropIndex("idx_conn_agg_unique").execute();
  await db.schema.dropIndex("idx_conn_agg_child").execute();
  await db.schema.dropIndex("idx_conn_agg_parent").execute();

  // ============================================================================
  // Step 2: Create new table with RESTRICT constraint
  // ============================================================================

  await db.schema
    .createTable("connection_aggregations_new")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE: When parent (Virtual MCP) is deleted, aggregations are removed
    .addColumn("parent_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    // RESTRICT: Prevent deletion of child connection if it's being used
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

  // ============================================================================
  // Step 3: Copy data from old table to new table
  // ============================================================================

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

  // ============================================================================
  // Step 4: Drop old table and rename new table
  // ============================================================================

  await db.schema.dropTable("connection_aggregations").execute();

  await db.schema
    .alterTable("connection_aggregations_new")
    .renameTo("connection_aggregations")
    .execute();

  // ============================================================================
  // Step 5: Rename FK constraints to clean names (PostgreSQL only)
  // SQLite doesn't support renaming constraints
  // ============================================================================

  // Check if we're on PostgreSQL by checking for PostgreSQL-specific function
  const isPostgres = await sql`SELECT current_database()`
    .execute(db)
    .then(() => true)
    .catch(() => false);

  if (isPostgres) {
    // Rename the auto-generated FK constraint names to clean names
    await sql`ALTER TABLE connection_aggregations RENAME CONSTRAINT connection_aggregations_new_parent_connection_id_fkey TO conn_agg_parent_fk`.execute(
      db,
    );
    await sql`ALTER TABLE connection_aggregations RENAME CONSTRAINT connection_aggregations_new_child_connection_id_fkey TO conn_agg_child_fk`.execute(
      db,
    );
  }

  // ============================================================================
  // Step 6: Recreate indexes
  // ============================================================================

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

export async function down(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Drop indexes
  // ============================================================================

  await db.schema.dropIndex("idx_conn_agg_unique").execute();
  await db.schema.dropIndex("idx_conn_agg_child").execute();
  await db.schema.dropIndex("idx_conn_agg_parent").execute();

  // ============================================================================
  // Step 2: Create table with original CASCADE constraint
  // ============================================================================

  await db.schema
    .createTable("connection_aggregations_new")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("parent_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    // Revert to CASCADE
    .addColumn("child_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("selected_tools", "text")
    .addColumn("selected_resources", "text")
    .addColumn("selected_prompts", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // ============================================================================
  // Step 3: Copy data
  // ============================================================================

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

  // ============================================================================
  // Step 4: Drop old table and rename new table
  // ============================================================================

  await db.schema.dropTable("connection_aggregations").execute();

  await db.schema
    .alterTable("connection_aggregations_new")
    .renameTo("connection_aggregations")
    .execute();

  // ============================================================================
  // Step 5: Rename FK constraints to clean names (PostgreSQL only)
  // ============================================================================

  // Check if we're on PostgreSQL by checking for PostgreSQL-specific function
  const isPostgres = await sql`SELECT current_database()`
    .execute(db)
    .then(() => true)
    .catch(() => false);

  if (isPostgres) {
    await sql`ALTER TABLE connection_aggregations RENAME CONSTRAINT connection_aggregations_new_parent_connection_id_fkey TO conn_agg_parent_fk`.execute(
      db,
    );
    await sql`ALTER TABLE connection_aggregations RENAME CONSTRAINT connection_aggregations_new_child_connection_id_fkey TO conn_agg_child_fk`.execute(
      db,
    );
  }

  // ============================================================================
  // Step 6: Recreate indexes
  // ============================================================================

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
