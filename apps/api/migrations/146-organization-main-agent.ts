import { Kysely } from "kysely";

/**
 * Per-org "main agent": the virtual MCP the org lands on (`/$org`) instead of
 * the Super Agent. Nullable text column holding a virtual MCP id; when null (or
 * pointing at a deleted agent) the landing falls back to the Super Agent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("main_agent_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("main_agent_id")
    .execute();
}
