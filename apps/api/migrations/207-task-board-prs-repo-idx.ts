/**
 * Index `task_board_item_prs` by (repo_owner, repo_name, pr_number).
 *
 * The GitHub webhook arrives knowing only a repo and a PR number and has to
 * find the card, if any. The table's only index is (organization_id,
 * task_board_item_id) and its PK is (task_board_item_id, url), so that lookup
 * was a full scan — on a path that fires for every check suite and PR comment
 * across every repo the App is installed on, most of which link to no card.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("task_board_item_prs_repo_idx")
    .on("task_board_item_prs")
    .columns(["repo_owner", "repo_name", "pr_number"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("task_board_item_prs_repo_idx").execute();
}
