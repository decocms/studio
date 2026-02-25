/**
 * Reports Migration
 *
 * Creates the reports table for storing automated reports (performance audits,
 * security scans, collection reorder rankings, etc.) served via REPORTS_BINDING.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("reports")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("category", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("source", "text")
    .addColumn("tags", "text")
    .addColumn("lifecycle_status", "text", (col) => col.defaultTo("unread"))
    .addColumn("sections", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("reports_organization_id")
    .on("reports")
    .columns(["organization_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("reports_organization_id").execute();
  await db.schema.dropTable("reports").execute();
}
