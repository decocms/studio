import { type Kysely, sql } from "kysely";

/**
 * Put back the cards 238 moved out of To Do, now that the board has a To Do
 * lane again (ready to start; nothing runs there on its own).
 *
 * Only a card still where 238 left it: in Backlog, with no lane change since
 * that migration's move. A card someone moved afterwards keeps their move.
 * Each restore gets a machine `status_changed` entry.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    WITH restored AS (
      UPDATE task_board_items AS i
         SET status = 'todo', updated_at = now()
        FROM task_board_activity AS a
       WHERE a.task_board_item_id = i.id
         AND a.action = 'status_changed'
         AND a.data->>'reason' = 'board_lanes'
         AND a.data->>'from' = 'todo'
         AND a.data->>'to' = 'triage'
         AND i.status = 'triage'
         AND NOT EXISTS (
           SELECT 1 FROM task_board_activity b
            WHERE b.task_board_item_id = a.task_board_item_id
              AND b.action = 'status_changed'
              AND (b.occurred_at, b.id) > (a.occurred_at, a.id)
         )
      RETURNING i.id
    )
    INSERT INTO task_board_activity (id, task_board_item_id, action, actor_id, data, occurred_at)
    SELECT 'act_' || replace(gen_random_uuid()::text, '-', ''),
           id,
           'status_changed',
           NULL,
           jsonb_build_object('from', 'triage', 'to', 'todo', 'reason', 'board_lanes'),
           now()
      FROM restored
  `.execute(db);
}

/** Not reversible, and not needed to roll back: the release before this one
 *  reads `todo`. */
export async function down(): Promise<void> {}
