import { type Kysely, sql } from "kysely";

/**
 * Per-org Jira Cloud integration: two-way sync between a Jira board and the
 * task board.
 *
 * `org_jira_integrations` is the tenant config: one row per org (UNIQUE),
 * Basic-auth credentials (`api_token` is vault-encrypted at the storage
 * layer), the board to mirror, and the per-tenant `status_mapping` jsonb
 * ({ "<jira status name>": "<board status>" }) — Jira workflows are arbitrary
 * per tenant, so the mapping is config, not code. Issues whose Jira status is
 * not mapped are skipped by the sync.
 *
 * The tenant picks a BOARD, not a project, because a JQL pull over a project
 * can never mirror what people call "the board": board-backlog membership (the
 * separate Backlog tab) is not a status or a filter, it only exists in the
 * Agile API (`/board/{id}/issue` minus `/board/{id}/backlog`). Boards also
 * carry the column names tenants actually know, which is what the mapping UI
 * shows. `jql_filter` is the escape hatch for the rest of a board's saved
 * filter (labels, sprints, components); non-standard issue types are already
 * excluded in code.
 *
 * `auto_delegate`: when an issue lands in a column mapped to the board's To Do
 * lane and the card has no assignee, the pull assigns the Super Agent (as the
 * integration's creator — `enqueueAgentRunForTask` runs under the card's
 * `assigned_by`), so moving a Jira issue is what starts the agent.
 *
 * `last_synced_at` doubles as the incremental-sync watermark: the cron pulls
 * issues `updated >=` it (with overlap), so a truncated run self-heals by
 * advancing the watermark only as far as it actually processed.
 *
 * `task_board_item_jira_links` ties a board card to its Jira issue. One issue
 * maps to at most one card per org. `jira_updated_at` is the issue's `updated`
 * as of our last write — pulls with an older-or-equal `updated` are no-ops,
 * which also dedupes the watermark overlap. `jira_status` is the last status
 * name SEEN OR SET on the Jira side: the pull only applies a status when
 * Jira's status actually changed (so our own agent-driven card moves aren't
 * yanked back by an unrelated issue edit), and the status push records what it
 * transitioned to (so the resulting pull echo is a no-op).
 *
 * `task_board_comment_jira_links` does the same for comments, which is what
 * makes comment sync idempotent and keeps a pushed comment from being pulled
 * back in as a new one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE org_jira_integrations (
      id text PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL UNIQUE REFERENCES organization(id) ON DELETE CASCADE,
      site_url text NOT NULL,
      email text NOT NULL,
      api_token text NOT NULL,
      board_id text,
      board_name text,
      status_mapping jsonb NOT NULL DEFAULT '{}',
      jql_filter text,
      webhook_secret text NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      enabled boolean NOT NULL DEFAULT false,
      auto_delegate boolean NOT NULL DEFAULT false,
      last_synced_at timestamptz,
      last_sync_error text,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE task_board_item_jira_links (
      item_id text PRIMARY KEY REFERENCES task_board_items(id) ON DELETE CASCADE,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      jira_issue_id text NOT NULL,
      jira_issue_key text NOT NULL,
      jira_updated_at timestamptz NOT NULL,
      jira_status text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, jira_issue_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE task_board_comment_jira_links (
      comment_id text PRIMARY KEY REFERENCES task_board_comments(id) ON DELETE CASCADE,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      jira_comment_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, jira_comment_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_board_comment_jira_links`.execute(db);
  await sql`DROP TABLE IF EXISTS task_board_item_jira_links`.execute(db);
  await sql`DROP TABLE IF EXISTS org_jira_integrations`.execute(db);
}
