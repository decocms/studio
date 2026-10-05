import { type Kysely, sql } from "kysely";
import { nanoid } from "nanoid";

/**
 * The org's "Jira" agent (`src/jira/chat-agent.ts`) for every org that already
 * has an enabled Jira integration. From now on `JIRA_INTEGRATION_UPSERT` and
 * `JIRA_INTEGRATION_DELETE` create and remove it; this covers the orgs that
 * configured Jira before the agent existed.
 *
 * Only the row: the agent's tools and instructions are applied from code at run
 * time (`resolveEffectiveStudioPackVirtualMcp`), so the copies written here are
 * placeholders and never go stale. Same shape as `VirtualMCPStorage.create`: a
 * VIRTUAL connection plus one direct aggregation over the org's `self`.
 * Skips orgs that already have the agent or have no `self` connection.
 */
const TOOLS = [
  "JIRA_ISSUE_SEARCH",
  "JIRA_ISSUE_GET",
  "JIRA_COMMENT_ADD",
  "JIRA_ISSUE_TRANSITION",
  "JIRA_REMOTE_LINK_ADD",
  "JIRA_ISSUE_CREATE",
  "JIRA_ATTACHMENT_DOWNLOAD",
  "JIRA_BOARD_COLUMNS_LIST",
  "JIRA_AUTOMATION_LIST",
  "JIRA_RUN_START",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ organization_id: string; created_by: string }>`
    SELECT i.organization_id, i.created_by
    FROM org_jira_integrations i
    WHERE i.enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM connections c WHERE c.id = 'studio-jira_' || i.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM connections s WHERE s.id = i.organization_id || '_self'
      )
  `.execute(db);

  const now = new Date().toISOString();
  for (const row of rows) {
    const id = `studio-jira_${row.organization_id}`;
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, updated_by, title, description, icon,
        app_name, app_id, connection_type, pinned, connection_url,
        connection_token, connection_headers, oauth_config,
        configuration_state, configuration_scopes, metadata, repository_id,
        bindings, status, created_at, updated_at
      ) VALUES (
        ${id}, ${row.organization_id}, ${row.created_by}, ${row.created_by},
        'Jira',
        'Read and move the Jira board and start agent runs on its issues, through the org''s Jira integration.',
        'icon://Ticket01?color=blue',
        NULL, NULL, 'VIRTUAL', false, ${`virtual://${id}`},
        NULL, NULL, NULL, NULL, NULL, ${JSON.stringify({ instructions: "" })},
        NULL, NULL, 'active', ${now}, ${now}
      )
    `.execute(db);
    await sql`
      INSERT INTO connection_aggregations (
        id, parent_connection_id, child_connection_id, selected_tools,
        selected_resources, selected_prompts, dependency_mode, created_at
      ) VALUES (
        ${`agg_${nanoid()}`}, ${id}, ${`${row.organization_id}_self`},
        ${JSON.stringify(TOOLS)}, NULL, ${JSON.stringify([])}, 'direct', ${now}
      )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM connection_aggregations
    WHERE parent_connection_id LIKE 'studio-jira\\_%'
  `.execute(db);
  await sql`DELETE FROM connections WHERE id LIKE 'studio-jira\\_%'`.execute(
    db,
  );
}
