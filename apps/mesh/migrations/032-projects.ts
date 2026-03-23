/**
 * Projects Migration
 *
 * Creates tables for the Projects feature:
 * - projects: Organization-scoped project workspaces
 * - project_plugin_configs: Per-project plugin configurations
 *
 * Also seeds an "org-admin" project for each existing organization,
 * migrating enabled_plugins from organization_settings.
 */

import { Kysely } from "kysely";
import { nanoid } from "nanoid";
// Inlined constants (previously from @decocms/mesh-sdk)
const ORG_ADMIN_PROJECT_SLUG = "org-admin";
const ORG_ADMIN_PROJECT_NAME = "Organization Admin";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create projects table
  await db.schema
    .createTable("projects")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("enabled_plugins", "text") // JSON array stored as text
    .addColumn("ui", "text") // JSON object stored as text
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  // Create unique index on (organization_id, slug)
  await db.schema
    .createIndex("projects_org_slug_unique")
    .on("projects")
    .columns(["organization_id", "slug"])
    .unique()
    .execute();

  // Create index for listing projects by org
  await db.schema
    .createIndex("projects_organization_id_idx")
    .on("projects")
    .column("organization_id")
    .execute();

  // Create project_plugin_configs table
  await db.schema
    .createTable("project_plugin_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("plugin_id", "text", (col) => col.notNull())
    .addColumn("connection_id", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("settings", "text") // JSON object stored as text
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  // Create unique index on (project_id, plugin_id)
  await db.schema
    .createIndex("project_plugin_configs_project_plugin_unique")
    .on("project_plugin_configs")
    .columns(["project_id", "plugin_id"])
    .unique()
    .execute();

  // Seed org-admin project for all existing organizations
  // This migrates enabled_plugins from organization_settings to the org-admin project
  const orgs = await db
    .selectFrom("organization" as never)
    .select(["id" as never])
    .execute();

  for (const org of orgs as Array<{ id: string }>) {
    const now = new Date().toISOString();
    const projectId = `proj_${nanoid()}`;

    // Get enabled_plugins from organization_settings if it exists
    const orgSettings = (await db
      .selectFrom("organization_settings" as never)
      .select(["enabled_plugins" as never])
      .where("organizationId" as never, "=" as never, org.id as never)
      .executeTakeFirst()) as { enabled_plugins: string | null } | undefined;

    await db
      .insertInto("projects" as never)
      .values({
        id: projectId,
        organization_id: org.id,
        slug: ORG_ADMIN_PROJECT_SLUG,
        name: ORG_ADMIN_PROJECT_NAME,
        description: null,
        enabled_plugins: orgSettings?.enabled_plugins ?? null,
        ui: null,
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_plugin_configs").execute();
  await db.schema.dropTable("projects").execute();
}
