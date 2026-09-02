import { Kysely } from "kysely";

/**
 * Drop the per-org "main agent" pointer (migration 146).
 *
 * It existed to send `/$org` to a chosen virtual MCP instead of the Super
 * Agent, back when the org landing had nothing of its own worth showing. The
 * organization home now opens on the org's agents, so the pointer only ever
 * skipped the page people actually wanted — and every read of it has been
 * removed, leaving a column nothing consults.
 *
 * `down` restores the column but NOT its values: the data is gone with the
 * drop, and each org would re-pick a landing agent. That is acceptable here
 * only because nothing reads the column any more, so an empty one behaves
 * exactly like a populated one did.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("main_agent_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("main_agent_id", "text")
    .execute();
}
