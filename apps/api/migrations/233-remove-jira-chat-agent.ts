import { type Kysely, sql } from "kysely";

/**
 * Deletes the "Jira" agents migration 231 created (`studio-jira_<orgId>`), the
 * same way `VirtualMCPStorage.delete` removes an agent: its threads, its
 * aggregations, then the VIRTUAL connection.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM threads WHERE virtual_mcp_id LIKE 'studio-jira\\_%'
  `.execute(db);
  await sql`
    DELETE FROM connection_aggregations
    WHERE parent_connection_id LIKE 'studio-jira\\_%'
  `.execute(db);
  await sql`
    DELETE FROM connections
    WHERE id LIKE 'studio-jira\\_%' AND connection_type = 'VIRTUAL'
  `.execute(db);
}

/** Nothing to restore: the agent no longer exists in code. */
export async function down(): Promise<void> {}
