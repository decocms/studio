import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "private_registry_monitor_result",
    "private_registry_monitor_run",
    "private_registry_monitor_connection",
    "private_registry_publish_api_key",
    "private_registry_publish_request",
    "private_registry_item",
    "virtual_mcp_plugin_configs",
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
  await sql`ALTER TABLE organization_settings
    DROP COLUMN IF EXISTS registry_config,
    DROP COLUMN IF EXISTS enabled_plugins`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION registry_try_jsonb(value text) RETURNS jsonb AS $fn$
    BEGIN RETURN value::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE`.execute(db);
  await sql`UPDATE connections SET metadata = (registry_try_jsonb(metadata) - 'enabled_plugins')::text
    WHERE registry_try_jsonb(metadata) ? 'enabled_plugins'`.execute(db);
  await sql`DROP FUNCTION registry_try_jsonb(text)`.execute(db);

  // Retire the seeded catalogs and connections created solely for monitoring.
  // Installed MCP connections keep their configuration and credentials.
  await sql`DELETE FROM connection_aggregations WHERE child_connection_id IN (
    SELECT id FROM connections
    WHERE (id = organization_id || '_registry' AND app_name = 'deco-registry')
       OR (id = organization_id || '_community-registry' AND app_name = 'mcp-registry')
       OR (app_name = 'private-registry-monitor' AND app_id = 'private-registry:monitor')
  )`.execute(db);
  await sql`DELETE FROM connections
    WHERE (id = organization_id || '_registry' AND app_name = 'deco-registry')
       OR (id = organization_id || '_community-registry' AND app_name = 'mcp-registry')
       OR (app_name = 'private-registry-monitor' AND app_id = 'private-registry:monitor')`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  throw new Error(
    "The private registry data was removed. Restore a database backup before reverting this migration.",
  );
}
