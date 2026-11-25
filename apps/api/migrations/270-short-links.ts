import { type Kysely, sql } from "kysely";

/**
 * Short share links: `/s/<label>-<id>` redirects to `target_path`, a page
 * inside the organization. One link per page, so sharing the same page twice
 * returns the same id. The target page still enforces access. Links go away
 * with their organization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("short_links")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("target_path", "text", (col) => col.notNull())
    .addColumn("label", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("title", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("created_by", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("short_links_org_target_unique", [
      "organization_id",
      "target_path",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("short_links").ifExists().execute();
}
