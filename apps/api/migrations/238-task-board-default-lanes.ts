import { type Kysely, sql } from "kysely";

/**
 * Move cards and column rules onto the board's new lanes.
 *
 * The board was Backlog → To Do → In Progress → In Review → Done, with the
 * agent reviewer working while a card read In Progress and In Review meaning
 * "a person's turn". It is now Backlog → In Progress (the implementer) → In
 * Review (the reviewer) → QA → Customer Approval → Ready for Deployment →
 * Post-deploy Validation → Done. `todo`, `approved` and `merged` are no
 * longer offered; the previous release already reads every new status, so
 * this needs no `down()` to be rolled back.
 *
 * Cards:
 * - To Do → Backlog. Delegating now starts a card In Progress, so a card left
 *   in To Do is either waiting for someone or parked by a failed run, which
 *   now lands in Backlog too.
 * - In Progress with a review cycle open → In Review, where the reviewer works.
 * - Approved → Ready for Deployment; Merged → Post-deploy Validation.
 * Each move gets a machine `status_changed` entry, so the card's timeline and
 * the analytics read the lane it is in. Cards already In Review stay: an
 * approved one moves to QA on its next sweep (`moveFinishedReviewToQa`), and
 * one handed to a person is still that person's.
 *
 * Column rules (`task_board_prompts`, `task_board_column_automations`), whose
 * ids embed the column key:
 * - In Progress's instructions were the reviewer's; they move to In Review,
 *   unless the org already wrote In Review instructions, which are then the
 *   reviewer's and win.
 * - To Do's instructions and "run the agent" rule were the implementer's;
 *   they move to In Progress (a rule already there wins).
 * - A "run the agent" rule on In Review is dropped: the board runs the
 *   reviewer on every card landing there.
 * - Approved and Merged rules follow their cards' lanes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await moveRules(db, "task_board_prompts", "tbp_", "in_progress", "in_review");
  await moveRules(db, "task_board_prompts", "tbp_", "todo", "in_progress");
  await moveRules(
    db,
    "task_board_prompts",
    "tbp_",
    "approved",
    "ready_for_deployment",
  );
  await moveRules(
    db,
    "task_board_prompts",
    "tbp_",
    "merged",
    "post_deploy_validation",
  );

  await sql`
    DELETE FROM task_board_column_automations WHERE column_key = 'in_review'
  `.execute(db);
  await moveRules(
    db,
    "task_board_column_automations",
    "tbca_",
    "todo",
    "in_progress",
  );
  await moveRules(
    db,
    "task_board_column_automations",
    "tbca_",
    "approved",
    "ready_for_deployment",
  );
  await moveRules(
    db,
    "task_board_column_automations",
    "tbca_",
    "merged",
    "post_deploy_validation",
  );

  await sql`
    WITH moved AS (
      UPDATE task_board_items AS i
         SET status = CASE
               WHEN prev.status = 'todo' THEN 'triage'
               WHEN prev.status = 'in_progress' THEN 'in_review'
               WHEN prev.status = 'approved' THEN 'ready_for_deployment'
               ELSE 'post_deploy_validation'
             END,
             updated_at = now()
        FROM (
          SELECT id, status FROM task_board_items
           WHERE status IN ('todo', 'approved', 'merged')
              OR (status = 'in_progress' AND review_cycle_started_at IS NOT NULL)
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

/** Not reversible, and not needed to roll back: see the module comment. */
export async function down(): Promise<void> {}

/** Move one column's rule rows to another column. The destination's own row,
 *  when the org has one, wins and the source row is dropped. */
async function moveRules(
  db: Kysely<unknown>,
  table: "task_board_prompts" | "task_board_column_automations",
  idPrefix: string,
  from: string,
  to: string,
): Promise<void> {
  await sql`
    DELETE FROM ${sql.table(table)} AS src
     WHERE src.column_key = ${from}
       AND EXISTS (
         SELECT 1 FROM ${sql.table(table)} AS dst
          WHERE dst.organization_id = src.organization_id
            AND dst.column_key = ${to}
       )
  `.execute(db);
  await sql`
    UPDATE ${sql.table(table)}
       SET column_key = ${to},
           id = ${idPrefix} || organization_id || '_' || ${to},
           updated_at = now()
     WHERE column_key = ${from}
  `.execute(db);
}
