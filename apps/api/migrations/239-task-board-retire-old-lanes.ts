import { type Kysely, sql } from "kysely";
import { moveRules } from "./238-task-board-default-lanes";

/**
 * Move what the release before 238 wrote to the old lanes while 238 rolled
 * out (`todo`, `approved`, `merged`), so the statuses can leave the code.
 *
 * Same moves as 238, for the same reasons: To Do → Backlog, Approved → Ready
 * for Deployment, Merged → Post-deploy Validation, each with a machine
 * `status_changed` entry, and the rules on those columns follow their cards.
 * A rule on To Do still means the implementer's, as it did in 238.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "task_board_prompts",
    "task_board_column_automations",
  ] as const) {
    const prefix = table === "task_board_prompts" ? "tbp_" : "tbca_";
    await moveRules(db, table, prefix, "todo", "in_progress");
    await moveRules(db, table, prefix, "approved", "ready_for_deployment");
    await moveRules(db, table, prefix, "merged", "post_deploy_validation");
  }

  await sql`
    WITH moved AS (
      UPDATE task_board_items AS i
         SET status = CASE prev.status
               WHEN 'todo' THEN 'triage'
               WHEN 'approved' THEN 'ready_for_deployment'
               ELSE 'post_deploy_validation'
             END,
             updated_at = now()
        FROM (
          SELECT id, status FROM task_board_items
           WHERE status IN ('todo', 'approved', 'merged')
        ) AS prev
       WHERE i.id = prev.id
      RETURNING i.id, prev.status AS from_status, i.status AS to_status
    )
    INSERT INTO task_board_activity (id, task_board_item_id, action, actor_id, data, occurred_at)
    SELECT 'act_' || replace(gen_random_uuid()::text, '-', ''),
           id,
           'status_changed',
           NULL,
           jsonb_build_object('from', from_status, 'to', to_status, 'reason', 'board_lanes'),
           now()
      FROM moved
  `.execute(db);
}

/** Not reversible, and not needed to roll back: the previous release reads
 *  every status this leaves. */
export async function down(): Promise<void> {}
