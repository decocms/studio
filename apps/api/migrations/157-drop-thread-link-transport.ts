import type { Kysely } from "kysely";

/**
 * Remove the retired desktop-link routing selector.
 *
 * Migration 100 introduced this nullable column while a thread could dispatch
 * through either the hosted sandbox or a user's link daemon. Desktop-link
 * dispatch has been removed, and no live writer or router reads the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("link_transport").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("link_transport", "text")
    .execute();
}
