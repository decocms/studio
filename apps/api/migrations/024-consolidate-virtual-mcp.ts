/**
 * Consolidate Virtual MCP into Connections Table
 *
 * This migration eliminates the separate `virtual_mcps` table by storing
 * Virtual MCPs as regular connections with `connection_type = 'VIRTUAL'`.
 *
 * Key changes:
 * - Migrate virtual_mcps data to connections table (keeping same IDs)
 * - Rename virtual_mcp_connections -> connection_aggregations
 * - Rename virtual_mcp_id -> parent_connection_id
 * - Rename connection_id -> child_connection_id
 * - Rename monitoring_logs.virtual_mcp_id -> agent_connection_id
 * - Drop virtual_mcps table
 *
 * The "same ID" strategy means no FK value updates are needed.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Migrate virtual_mcps data to connections table
  // We keep the SAME ID so that FK references remain valid
  // ============================================================================

  await sql`
    INSERT INTO connections (
      id,
      organization_id,
      created_by,
      title,
      description,
      icon,
      app_name,
      app_id,
      connection_type,
      connection_url,
      connection_token,
      connection_headers,
      oauth_config,
      configuration_state,
      configuration_scopes,
      metadata,
      tools,
      bindings,
      status,
      created_at,
      updated_at
    )
    SELECT 
      id,
      organization_id,
      created_by,
      title,
      description,
      icon,
      NULL,  -- app_name
      NULL,  -- app_id
      'VIRTUAL',
      'virtual://' || id,  -- connection_url references self
      NULL,  -- connection_token
      NULL,  -- connection_headers
      NULL,  -- oauth_config
      NULL,  -- configuration_state
      NULL,  -- configuration_scopes
      NULL,  -- metadata
      NULL,  -- tools (aggregated dynamically)
      NULL,  -- bindings
      status,
      created_at,
      updated_at
    FROM virtual_mcps
  `.execute(db);

  // ============================================================================
  // Step 2: Drop old indexes on virtual_mcp_connections before renaming
  // ============================================================================

  await db.schema.dropIndex("idx_virtual_mcp_connections_unique").execute();
  await db.schema.dropIndex("idx_virtual_mcp_connections_connection").execute();
  await db.schema
    .dropIndex("idx_virtual_mcp_connections_virtual_mcp")
    .execute();

  // ============================================================================
  // Step 3: Drop old FK constraints (PostgreSQL only - SQLite doesn't support this)
  // These reference virtual_mcps which we want to drop
  // ============================================================================

  // Check if we're on PostgreSQL by checking for PostgreSQL-specific function
  const isPostgres = await sql`SELECT current_database()`
    .execute(db)
    .then(() => true)
    .catch(() => false);

  if (isPostgres) {
    // Drop FK constraints - PostgreSQL keeps these after rename
    // PostgreSQL constraint names from original migration 010-gateways.ts
    await sql`ALTER TABLE virtual_mcp_connections DROP CONSTRAINT IF EXISTS gateway_connections_gateway_id_fkey`.execute(
      db,
    );
    await sql`ALTER TABLE virtual_mcp_connections DROP CONSTRAINT IF EXISTS gateway_connections_connection_id_fkey`.execute(
      db,
    );
    // Also try the renamed constraint names (if migration 022 created new ones)
    await sql`ALTER TABLE virtual_mcp_connections DROP CONSTRAINT IF EXISTS virtual_mcp_connections_virtual_mcp_id_fkey`.execute(
      db,
    );
    await sql`ALTER TABLE virtual_mcp_connections DROP CONSTRAINT IF EXISTS virtual_mcp_connections_connection_id_fkey`.execute(
      db,
    );
  }
  // SQLite: FK constraints don't need to be dropped - they're part of the table definition
  // and SQLite doesn't enforce them by default anyway

  // ============================================================================
  // Step 4: Rename virtual_mcp_connections -> connection_aggregations
  // ============================================================================

  await db.schema
    .alterTable("virtual_mcp_connections")
    .renameTo("connection_aggregations")
    .execute();

  // ============================================================================
  // Step 5: Rename columns in connection_aggregations
  // Since we kept the same IDs, no value updates needed
  // ============================================================================

  await db.schema
    .alterTable("connection_aggregations")
    .renameColumn("virtual_mcp_id", "parent_connection_id")
    .execute();

  await db.schema
    .alterTable("connection_aggregations")
    .renameColumn("connection_id", "child_connection_id")
    .execute();

  // ============================================================================
  // Step 6: Add new FK constraints pointing to connections table (PostgreSQL only)
  // SQLite: FK constraints are defined at table creation, not added later
  // Migration 024 will recreate the table with proper FK constraints for both DBs
  // ============================================================================

  if (isPostgres) {
    await sql`ALTER TABLE connection_aggregations ADD CONSTRAINT conn_agg_parent_fk FOREIGN KEY (parent_connection_id) REFERENCES connections(id) ON DELETE CASCADE`.execute(
      db,
    );
    await sql`ALTER TABLE connection_aggregations ADD CONSTRAINT conn_agg_child_fk FOREIGN KEY (child_connection_id) REFERENCES connections(id) ON DELETE CASCADE`.execute(
      db,
    );
  }

  // ============================================================================
  // Step 7: Drop monitoring_logs.virtual_mcp_id column (no longer needed)
  // Since Virtual MCPs are now connections, connection_id is sufficient
  // ============================================================================

  // Drop old index first
  await db.schema.dropIndex("monitoring_logs_virtual_mcp_timestamp").execute();

  // Drop the virtual_mcp_id column
  await db.schema
    .alterTable("monitoring_logs")
    .dropColumn("virtual_mcp_id")
    .execute();

  // ============================================================================
  // Step 8: Drop virtual_mcps table and its indexes
  // ============================================================================

  await db.schema.dropIndex("idx_virtual_mcps_org_status").execute();
  await db.schema.dropIndex("idx_virtual_mcps_org").execute();
  await db.schema.dropTable("virtual_mcps").execute();

  // ============================================================================
  // Step 9: Create new indexes
  // ============================================================================

  // Indexes for connection_aggregations
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
  // Step 1: Recreate virtual_mcps table
  // ============================================================================

  await db.schema
    .createTable("virtual_mcps")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("tool_selection_mode", "text", (col) =>
      col.notNull().defaultTo("inclusion"),
    )
    .addColumn("icon", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("created_by", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("updated_by", "text")
    .execute();

  // ============================================================================
  // Step 2: Migrate VIRTUAL connections back to virtual_mcps
  // ============================================================================

  await sql`
    INSERT INTO virtual_mcps (
      id, organization_id, title, description, icon, status,
      created_at, updated_at, created_by, updated_by, tool_selection_mode
    )
    SELECT 
      id, organization_id, title, description, icon, status,
      created_at, updated_at, created_by, NULL, 'inclusion'
    FROM connections
    WHERE connection_type = 'VIRTUAL'
  `.execute(db);

  // ============================================================================
  // Step 3: Drop new indexes
  // ============================================================================

  await db.schema.dropIndex("idx_conn_agg_unique").execute();
  await db.schema.dropIndex("idx_conn_agg_child").execute();
  await db.schema.dropIndex("idx_conn_agg_parent").execute();

  // ============================================================================
  // Step 4: Add back monitoring_logs.virtual_mcp_id column
  // ============================================================================

  await db.schema
    .alterTable("monitoring_logs")
    .addColumn("virtual_mcp_id", "text")
    .execute();

  // ============================================================================
  // Step 5: Rename connection_aggregations columns back
  // ============================================================================

  await db.schema
    .alterTable("connection_aggregations")
    .renameColumn("child_connection_id", "connection_id")
    .execute();

  await db.schema
    .alterTable("connection_aggregations")
    .renameColumn("parent_connection_id", "virtual_mcp_id")
    .execute();

  // ============================================================================
  // Step 6: Rename table back
  // ============================================================================

  await db.schema
    .alterTable("connection_aggregations")
    .renameTo("virtual_mcp_connections")
    .execute();

  // ============================================================================
  // Step 7: Delete VIRTUAL connections from connections table
  // ============================================================================

  await sql`DELETE FROM connections WHERE connection_type = 'VIRTUAL'`.execute(
    db,
  );

  // ============================================================================
  // Step 8: Recreate original indexes
  // ============================================================================

  // Indexes for virtual_mcps
  await db.schema
    .createIndex("idx_virtual_mcps_org")
    .on("virtual_mcps")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_virtual_mcps_org_status")
    .on("virtual_mcps")
    .columns(["organization_id", "status"])
    .execute();

  // Indexes for virtual_mcp_connections
  await db.schema
    .createIndex("idx_virtual_mcp_connections_virtual_mcp")
    .on("virtual_mcp_connections")
    .columns(["virtual_mcp_id"])
    .execute();

  await db.schema
    .createIndex("idx_virtual_mcp_connections_connection")
    .on("virtual_mcp_connections")
    .columns(["connection_id"])
    .execute();

  await db.schema
    .createIndex("idx_virtual_mcp_connections_unique")
    .on("virtual_mcp_connections")
    .columns(["virtual_mcp_id", "connection_id"])
    .unique()
    .execute();

  // Index for monitoring_logs
  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_timestamp")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id", "timestamp"])
    .execute();
}
