/**
 * Add icon field to gateways table
 *
 * Allows gateways to have a custom icon, typically inherited from the connection
 * when created via "Expose via Gateway" feature.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("gateways").addColumn("icon", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("gateways").dropColumn("icon").execute();
}
