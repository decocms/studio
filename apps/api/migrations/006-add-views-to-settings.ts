/**
 * Add Sidebar Items to Organization Settings Migration
 *
 * Adds a sidebar_items JSONB column to organization_settings table.
 * Sidebar items is an array of { title: string, url: string, connectionId: string }
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("sidebar_items", sql`text`) // JSONB stored as text in SQLite
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("sidebar_items")
    .execute();
}
