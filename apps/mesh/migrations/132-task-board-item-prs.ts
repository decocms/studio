import { sql, type Kysely } from "kysely";

/**
 * Links task board items to the GitHub pull requests an agent opened for them.
 *
 * When a Super Agent run opens a PR (via the GitHub MCP `create_pull_request`
 * tool, or `gh pr create` / a REST POST in bash — from the main run OR a
 * subtask), we capture the PR's identity and link it here so the Task modal can
 * show it as activity and fetch its live state via the GitHub MCP.
 *
 * Identity only — PR title/state are fetched live, never persisted here.
 * `connection_id` is the source GitHub MCP connection when known (MCP path);
 * null for bash-opened PRs, where the fetcher falls back to the org's shared
 * GitHub connection.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_item_prs")
    .addColumn("task_board_item_id", "text", (col) => col.notNull())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("pr_number", "integer", (col) => col.notNull())
    .addColumn("repo_owner", "text", (col) => col.notNull())
    .addColumn("repo_name", "text", (col) => col.notNull())
    .addColumn("connection_id", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // One row per (task, PR url) — re-capturing the same PR is a no-op.
    .addPrimaryKeyConstraint("task_board_item_prs_pkey", [
      "task_board_item_id",
      "url",
    ])
    .execute();

  // Modal loads a task's PRs, scoped to the org.
  await db.schema
    .createIndex("task_board_item_prs_item_idx")
    .on("task_board_item_prs")
    .columns(["organization_id", "task_board_item_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_item_prs").execute();
}
