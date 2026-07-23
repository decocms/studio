/**
 * Merge Projects & Agents Migration
 *
 * This migration merges the separate `projects` concept into the existing
 * VIRTUAL connections system by introducing a `subtype` column on `connections`.
 *
 * Key changes:
 * - Add `subtype` column to `connections` (nullable, 'agent' | 'project')
 * - Backfill existing VIRTUAL connections with subtype = 'agent'
 * - Create `virtual_mcp_plugin_configs` table
 * - Migrate projects -> VIRTUAL connections with subtype = 'project'
 * - Migrate project_connections -> connection_aggregations
 * - Migrate project_plugin_configs -> virtual_mcp_plugin_configs
 * - Drop project tables
 */

import { type Kysely, sql } from "kysely";
import { nanoid } from "nanoid";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // Step 1: Add `subtype` column to `connections` table
  // ============================================================================

  await db.schema
    .alterTable("connections")
    .addColumn("subtype", "text")
    .execute();

  await sql`
    ALTER TABLE connections
    ADD CONSTRAINT chk_connections_subtype
    CHECK (subtype IN ('agent', 'project') OR subtype IS NULL)
  `.execute(db);

  await db.schema
    .createIndex("idx_connections_org_type_subtype")
    .on("connections")
    .columns(["organization_id", "connection_type", "subtype"])
    .execute();

  // ============================================================================
  // Step 2: Backfill existing VIRTUAL connections with subtype = 'agent'
  // ============================================================================

  await sql`
    UPDATE connections
    SET subtype = 'agent'
    WHERE connection_type = 'VIRTUAL'
  `.execute(db);

  // ============================================================================
  // Step 3: Create `virtual_mcp_plugin_configs` table
  // ============================================================================

  await db.schema
    .createTable("virtual_mcp_plugin_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("virtual_mcp_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("plugin_id", "text", (col) => col.notNull())
    .addColumn("connection_id", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("settings", "text") // JSON object stored as text
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_vmpc_unique")
    .on("virtual_mcp_plugin_configs")
    .columns(["virtual_mcp_id", "plugin_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_vmpc_virtual_mcp_id")
    .on("virtual_mcp_plugin_configs")
    .columns(["virtual_mcp_id"])
    .execute();

  // ============================================================================
  // Step 4: Migrate projects into VIRTUAL connections with subtype = 'project'
  // ============================================================================

  const projects = (await db
    .selectFrom("projects" as never)
    .select([
      "id" as never,
      "organization_id" as never,
      "slug" as never,
      "name" as never,
      "description" as never,
      "enabled_plugins" as never,
      "ui" as never,
      "created_at" as never,
      "updated_at" as never,
    ])
    .execute()) as Array<{
    id: string;
    organization_id: string;
    slug: string;
    name: string;
    description: string | null;
    enabled_plugins: string | null;
    ui: string | null;
    created_at: string;
    updated_at: string;
  }>;

  // Build a map of organization_id -> owner user_id for created_by attribution
  const orgOwners = (await db
    .selectFrom("member" as never)
    .select(["organizationId" as never, "userId" as never])
    .where("role" as never, "=", "owner" as never)
    .execute()) as Array<{ organizationId: string; userId: string }>;

  const orgOwnerMap = new Map<string, string>();
  for (const row of orgOwners) {
    orgOwnerMap.set(row.organizationId, row.userId);
  }

  // Map from old project ID to new virtual MCP connection ID
  const projectIdToConnectionId = new Map<string, string>();

  for (const project of projects) {
    const connectionId = `vir_${nanoid()}`;
    projectIdToConnectionId.set(project.id, connectionId);

    // Parse project.ui JSON once
    const parsedUi = project.ui ? JSON.parse(project.ui) : null;

    const metadata = JSON.stringify({
      enabled_plugins: project.enabled_plugins
        ? JSON.parse(project.enabled_plugins)
        : null,
      ui: parsedUi,
      migrated_from_project: project.id,
      migrated_project_slug: project.slug,
    });

    // Use org owner as created_by (FK constraint requires valid user id)
    const createdBy = orgOwnerMap.get(project.organization_id);
    if (!createdBy) continue; // skip orphaned projects with no org owner

    await db
      .insertInto("connections" as never)
      .values({
        id: connectionId,
        organization_id: project.organization_id,
        created_by: createdBy,
        updated_by: null,
        title: project.name,
        description: project.description,
        icon: parsedUi?.icon ?? null,
        app_name: null,
        app_id: null,
        connection_type: "VIRTUAL",
        connection_url: `virtual://${connectionId}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata,
        bindings: null,
        status: "active",
        subtype: "project",
        created_at: project.created_at,
        updated_at: project.updated_at,
      } as never)
      .execute();
  }

  // ============================================================================
  // Step 5: Migrate project_connections -> connection_aggregations
  // ============================================================================

  const projectConnections = (await db
    .selectFrom("project_connections" as never)
    .select([
      "project_id" as never,
      "connection_id" as never,
      "created_at" as never,
    ])
    .execute()) as Array<{
    project_id: string;
    connection_id: string;
    created_at: string;
  }>;

  for (const pc of projectConnections) {
    const parentConnectionId = projectIdToConnectionId.get(pc.project_id);
    if (!parentConnectionId) continue;

    await db
      .insertInto("connection_aggregations" as never)
      .values({
        id: `agg_${nanoid()}`,
        parent_connection_id: parentConnectionId,
        child_connection_id: pc.connection_id,
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
        dependency_mode: "direct",
        created_at: pc.created_at,
      } as never)
      .onConflict((oc: any) => oc.doNothing())
      .execute();
  }

  // ============================================================================
  // Step 6: Migrate project_plugin_configs -> virtual_mcp_plugin_configs
  // ============================================================================

  const pluginConfigs = (await db
    .selectFrom("project_plugin_configs" as never)
    .select([
      "id" as never,
      "project_id" as never,
      "plugin_id" as never,
      "connection_id" as never,
      "settings" as never,
      "created_at" as never,
      "updated_at" as never,
    ])
    .execute()) as Array<{
    id: string;
    project_id: string;
    plugin_id: string;
    connection_id: string | null;
    settings: string | null;
    created_at: string;
    updated_at: string;
  }>;

  for (const config of pluginConfigs) {
    const virtualMcpId = projectIdToConnectionId.get(config.project_id);
    if (!virtualMcpId) continue;

    await db
      .insertInto("virtual_mcp_plugin_configs" as never)
      .values({
        id: `vpc_${nanoid()}`,
        virtual_mcp_id: virtualMcpId,
        plugin_id: config.plugin_id,
        connection_id: config.connection_id,
        settings: config.settings,
        created_at: config.created_at,
        updated_at: config.updated_at,
      } as never)
      .execute();
  }

  // ============================================================================
  // Step 7: Drop project tables (order matters for FK constraints)
  // ============================================================================

  await db.schema.dropTable("project_plugin_configs").execute();
  await db.schema.dropTable("project_connections").execute();
  await db.schema.dropTable("projects").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // WARNING: This rollback will lose migrated data. Projects, project_connections,
  // and project_plugin_configs cannot be fully restored from the merged state.

  // Drop virtual_mcp_plugin_configs table
  await db.schema.dropTable("virtual_mcp_plugin_configs").ifExists().execute();

  // Drop composite index
  await db.schema
    .dropIndex("idx_connections_org_type_subtype")
    .ifExists()
    .execute();

  // Drop CHECK constraint
  await sql`
    ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS chk_connections_subtype
  `.execute(db);

  // Drop subtype column
  await db.schema.alterTable("connections").dropColumn("subtype").execute();
}
