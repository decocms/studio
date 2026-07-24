/**
 * Rename Gateway to Virtual MCP
 *
 * This migration renames:
 * - Table: gateways → virtual_mcps
 * - Table: gateway_connections → virtual_mcp_connections
 * - Column: gateway_connections.gateway_id → virtual_mcp_connections.virtual_mcp_id
 * - Column: monitoring_logs.gateway_id → monitoring_logs.virtual_mcp_id
 * - All related indexes
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Drop existing indexes on gateway tables
  // ============================================================================

  // Drop gateway_connections indexes
  await db.schema.dropIndex("idx_gateway_connections_unique").execute();
  await db.schema.dropIndex("idx_gateway_connections_connection").execute();
  await db.schema.dropIndex("idx_gateway_connections_gateway").execute();

  // Drop gateways indexes
  await db.schema.dropIndex("idx_gateways_org_status").execute();
  await db.schema.dropIndex("idx_gateways_org").execute();

  // Drop monitoring_logs gateway index
  await db.schema.dropIndex("monitoring_logs_gateway_timestamp").execute();

  // ============================================================================
  // Step 2: Rename tables
  // ============================================================================

  await db.schema.alterTable("gateways").renameTo("virtual_mcps").execute();

  await db.schema
    .alterTable("gateway_connections")
    .renameTo("virtual_mcp_connections")
    .execute();

  // ============================================================================
  // Step 3: Rename columns
  // ============================================================================

  // Rename gateway_id to virtual_mcp_id in virtual_mcp_connections
  await db.schema
    .alterTable("virtual_mcp_connections")
    .renameColumn("gateway_id", "virtual_mcp_id")
    .execute();

  // Rename gateway_id to virtual_mcp_id in monitoring_logs
  await db.schema
    .alterTable("monitoring_logs")
    .renameColumn("gateway_id", "virtual_mcp_id")
    .execute();

  // ============================================================================
  // Step 4: Recreate indexes with new names
  // ============================================================================

  // Indexes for virtual_mcps table
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

  // Indexes for virtual_mcp_connections table
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

  // Index for monitoring_logs virtual_mcp_id
  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_timestamp")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id", "timestamp"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Drop new indexes
  // ============================================================================

  await db.schema.dropIndex("monitoring_logs_virtual_mcp_timestamp").execute();
  await db.schema.dropIndex("idx_virtual_mcp_connections_unique").execute();
  await db.schema.dropIndex("idx_virtual_mcp_connections_connection").execute();
  await db.schema
    .dropIndex("idx_virtual_mcp_connections_virtual_mcp")
    .execute();
  await db.schema.dropIndex("idx_virtual_mcps_org_status").execute();
  await db.schema.dropIndex("idx_virtual_mcps_org").execute();

  // ============================================================================
  // Step 2: Rename columns back
  // ============================================================================

  await db.schema
    .alterTable("monitoring_logs")
    .renameColumn("virtual_mcp_id", "gateway_id")
    .execute();

  await db.schema
    .alterTable("virtual_mcp_connections")
    .renameColumn("virtual_mcp_id", "gateway_id")
    .execute();

  // ============================================================================
  // Step 3: Rename tables back
  // ============================================================================

  await db.schema
    .alterTable("virtual_mcp_connections")
    .renameTo("gateway_connections")
    .execute();

  await db.schema.alterTable("virtual_mcps").renameTo("gateways").execute();

  // ============================================================================
  // Step 4: Recreate original indexes
  // ============================================================================

  await db.schema
    .createIndex("idx_gateways_org")
    .on("gateways")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_gateways_org_status")
    .on("gateways")
    .columns(["organization_id", "status"])
    .execute();

  await db.schema
    .createIndex("idx_gateway_connections_gateway")
    .on("gateway_connections")
    .columns(["gateway_id"])
    .execute();

  await db.schema
    .createIndex("idx_gateway_connections_connection")
    .on("gateway_connections")
    .columns(["connection_id"])
    .execute();

  await db.schema
    .createIndex("idx_gateway_connections_unique")
    .on("gateway_connections")
    .columns(["gateway_id", "connection_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("monitoring_logs_gateway_timestamp")
    .on("monitoring_logs")
    .columns(["gateway_id", "timestamp"])
    .execute();
}
