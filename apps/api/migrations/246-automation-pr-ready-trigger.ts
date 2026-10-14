import { type Kysely, sql } from "kysely";

/**
 * A trigger that fires when a card's pull request is ready for review: open,
 * not a draft, its checks done, its preview on the latest commit. The board's
 * review sweep decides that and fires it; the built-in Reviewer answers it.
 * `column_key` names the lane the card is in (In Review).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`
    ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type
      CHECK (type IN ('cron', 'event', 'webhook', 'board_column_transition',
                      'board_pr_ready'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM automation_triggers WHERE type = 'board_pr_ready'`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`
    ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type
      CHECK (type IN ('cron', 'event', 'webhook', 'board_column_transition'))
  `.execute(db);
}
