import { type Kysely, sql } from "kysely";

/**
 * The project sidebar, as two JSON documents validated by
 * `@decocms/shared/project-sidebar`:
 *
 * - `org_project_folders`: one row per org, its folder list (org-wide).
 * - `user_sidebar_preferences`: one row per (user, org), that member's pins
 *   and hides.
 *
 * Both cascade on org (and user) deletion. Ids inside the documents are not
 * foreign keys; readers drop the ones that no longer resolve.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("org_project_folders")
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("folders", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createTable("user_sidebar_preferences")
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("preferences", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addPrimaryKeyConstraint("user_sidebar_preferences_pkey", [
      "user_id",
      "organization_id",
    ])
    .execute();

  // Not a PK prefix; keeps org deletion's cascade off a sequential scan.
  await db.schema
    .createIndex("user_sidebar_preferences_organization_id_idx")
    .on("user_sidebar_preferences")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_sidebar_preferences").execute();
  await db.schema.dropTable("org_project_folders").execute();
}
