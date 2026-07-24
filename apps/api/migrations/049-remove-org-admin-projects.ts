/**
 * Remove Organization Admin Projects
 *
 * Migration 048 converted all projects (including the "Organization Admin"
 * org-admin project) into VIRTUAL connections with subtype='project'.
 * The org-admin project is no longer needed — the org-level context is now
 * handled synthetically in the UI. This migration removes those leftover
 * connections by matching on metadata.migrated_project_slug = 'org-admin'.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Delete VIRTUAL connections that were migrated from the old org-admin project.
  // CASCADE on connection_aggregations and virtual_mcp_plugin_configs will clean up related rows.
  await sql`
    DELETE FROM connections
    WHERE connection_type = 'VIRTUAL'
      AND subtype = 'project'
      AND metadata::json->>'migrated_project_slug' = 'org-admin'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // The org-admin connections cannot be reliably restored.
  // No-op: the UI already handles org-level context synthetically.
}
