/**
 * Thread Agent IDs Migration
 *
 * Adds `agent_ids` column to threads to track which agents have been used
 * in each task. Stored as a JSON array of connection IDs (ordered by first
 * appearance). The first element is the "primary" agent for the task.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("agent_ids", "text", (col) => col.defaultTo("[]"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("agent_ids").execute();
}
