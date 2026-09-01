import { type Kysely, sql } from "kysely";

/**
 * What a board does when a card lands in one of its columns.
 *
 * Replaces `org_jira_integrations.auto_delegate`, which could only ever mean
 * one thing on one hardcoded lane, and only for an org that had Jira at all.
 * A rule here names the column and the instruction, so an org can have several
 * and none of them have to be Studio's idea.
 *
 * The row's existence is the switch: deleting it turns the automation off,
 * which keeps "configured" and "enabled" from drifting apart.
 *
 * `prompt` null means the Super Agent's own instruction — what every run uses
 * today, and what a rule migrated from `auto_delegate` has to keep meaning.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_column_automations")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("column_key", "text", (col) => col.notNull())
    .addColumn("prompt", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("task_board_column_automations_org_column_uniq")
    .ifNotExists()
    .on("task_board_column_automations")
    .columns(["organization_id", "column_key"])
    .unique()
    .execute();

  // Carry the old switch over. `auto_delegate` fired the Super Agent on the To
  // Do lane with its built-in instruction, which is a null prompt here.
  await sql`
    INSERT INTO task_board_column_automations
      (id, organization_id, column_key, prompt)
    SELECT 'tbca_' || organization_id || '_todo', organization_id, 'todo', NULL
      FROM org_jira_integrations
     WHERE auto_delegate = true
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable("task_board_column_automations")
    .ifExists()
    .execute();
}
