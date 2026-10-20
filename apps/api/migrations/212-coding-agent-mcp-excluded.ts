import type { Kysely } from "kysely";

/**
 * Which of the org's MCP connections a coding-agent run must NOT mount.
 *
 * `coding_agent_org_mcps` is all-or-nothing: on, a run mounts every active
 * connection the dispatching user can reach. Some of them are the wrong tool
 * for a coding run even so — an org whose Jira is also connected as an MCP
 * would hand a Jira-triggered run two ways to reach the same issue, one of
 * which bypasses the vault-held credential the run tools exist to keep out of
 * the sandbox.
 *
 * A list, not a boolean, so it is its own column rather than a key in the
 * `flags` bag — same shape and storage as `enabled_plugins` (JSON in text).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("coding_agent_mcp_excluded", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("coding_agent_mcp_excluded")
    .execute();
}
