/**
 * Gateway Tables Migration
 *
 * Creates tables for MCP virtual gateways that aggregate tools from multiple connections.
 * - gateways: Virtual gateway entities with tool selection strategy
 * - gateway_connections: Many-to-many relationship linking gateways to connections with selected tools
 *
 * Gateways allow users to create custom MCP endpoints that expose a curated set of tools
 * from multiple underlying connections.
 *
 * tool_selection_strategy values:
 * - null: Include selected tools/connections (default behavior)
 * - "exclusion": Exclude selected tools/connections (inverse filter)
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create gateways table
  // Virtual gateway entities that aggregate tools from multiple connections
  await db.schema
    .createTable("gateways")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When organization is deleted, gateways are automatically removed
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    // Tool selection strategy: null = include selected, "exclusion" = exclude selected
    .addColumn("tool_selection_strategy", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active")) // active, inactive
    // Is this the default gateway for the organization? (only one per org)
    .addColumn("is_default", "integer", (col) => col.notNull().defaultTo(0))
    // Audit fields
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

  // Create gateway_connections table
  // Many-to-many relationship linking gateways to connections with selected tools
  await db.schema
    .createTable("gateway_connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When gateway is deleted, associations are automatically removed
    .addColumn("gateway_id", "text", (col) =>
      col.notNull().references("gateways.id").onDelete("cascade"),
    )
    // CASCADE DELETE: When connection is deleted, associations are automatically removed
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    // Selected tools as JSON array: ["TOOL_A", "TOOL_B"] or null for all tools
    .addColumn("selected_tools", "text")
    // Audit fields
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Indexes for gateways table
  // Query by organization
  await db.schema
    .createIndex("idx_gateways_org")
    .on("gateways")
    .columns(["organization_id"])
    .execute();

  // Query by organization and status
  await db.schema
    .createIndex("idx_gateways_org_status")
    .on("gateways")
    .columns(["organization_id", "status"])
    .execute();

  // Partial unique index for one default per org
  // SQLite supports partial indexes with WHERE clause
  await sql`CREATE UNIQUE INDEX idx_gateways_default_per_org ON gateways (organization_id) WHERE is_default = 1`.execute(
    db,
  );

  // Indexes for gateway_connections table
  // Query by gateway
  await db.schema
    .createIndex("idx_gateway_connections_gateway")
    .on("gateway_connections")
    .columns(["gateway_id"])
    .execute();

  // Query by connection
  await db.schema
    .createIndex("idx_gateway_connections_connection")
    .on("gateway_connections")
    .columns(["connection_id"])
    .execute();

  // Unique constraint: a connection can only be added once per gateway
  await db.schema
    .createIndex("idx_gateway_connections_unique")
    .on("gateway_connections")
    .columns(["gateway_id", "connection_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("idx_gateway_connections_unique").execute();
  await db.schema.dropIndex("idx_gateway_connections_connection").execute();
  await db.schema.dropIndex("idx_gateway_connections_gateway").execute();
  await db.schema.dropIndex("idx_gateways_default_per_org").execute();
  await db.schema.dropIndex("idx_gateways_org_status").execute();
  await db.schema.dropIndex("idx_gateways_org").execute();

  // Drop tables in reverse order (respecting foreign keys)
  await db.schema.dropTable("gateway_connections").execute();
  await db.schema.dropTable("gateways").execute();
}
