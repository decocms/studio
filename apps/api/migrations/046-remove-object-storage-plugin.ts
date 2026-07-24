/**
 * Remove dangling references to the "object-storage" plugin.
 *
 * The plugin package (mesh-plugin-object-storage) has been removed.
 * This migration cleans up any stored references in enabled_plugins
 * arrays and plugin config rows.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Remove "object-storage" from organization_settings.enabled_plugins
  await sql`
    UPDATE organization_settings
    SET enabled_plugins = (
      SELECT COALESCE(json_agg(elem), '[]'::json)::text
      FROM json_array_elements_text(enabled_plugins::json) AS elem
      WHERE elem != 'object-storage'
    )
    WHERE enabled_plugins IS NOT NULL
      AND enabled_plugins LIKE '%object-storage%'
  `.execute(db);

  // Remove "object-storage" from projects.enabled_plugins
  await sql`
    UPDATE projects
    SET enabled_plugins = (
      SELECT COALESCE(json_agg(elem), '[]'::json)::text
      FROM json_array_elements_text(enabled_plugins::json) AS elem
      WHERE elem != 'object-storage'
    )
    WHERE enabled_plugins IS NOT NULL
      AND enabled_plugins LIKE '%object-storage%'
  `.execute(db);

  // Delete plugin configs for object-storage
  await sql`
    DELETE FROM project_plugin_configs
    WHERE plugin_id = 'object-storage'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op: we can't restore the removed plugin references
}
