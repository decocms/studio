import { type Kysely, sql } from "kysely";

/**
 * Instructions the org appends to the SYSTEM PROMPT of every agent run
 * dispatched from a task board card — house rules ("use pnpm", "never touch
 * the generated client") that belong to the work, not to one card.
 *
 * Not the same thing as `task_board_column_automations`, which sits next to it:
 * that table's `prompt` is the run's opening USER instruction on the column
 * that triggered it ("what to do with a card landing here"), and only exists
 * where a rule fires. This one is context every run carries regardless of how
 * it started.
 *
 * `column_key` NULL is the org-wide row — the one the Settings page writes.
 * A non-null key scopes the same text to cards in one column, which nothing
 * writes yet; the shape is here so adding it later is a UI, not a migration.
 *
 * Uniqueness rides the deterministic primary key rather than a unique index on
 * `(organization_id, column_key)`: Postgres treats NULLs as distinct, so such
 * an index would happily admit two org-wide rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_prompts")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("column_key", "text")
    .addColumn("prompt", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Every read is "this org's prompts" — the dispatch path runs it per run.
  await db.schema
    .createIndex("task_board_prompts_org_idx")
    .ifNotExists()
    .on("task_board_prompts")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_prompts").ifExists().execute();
}
