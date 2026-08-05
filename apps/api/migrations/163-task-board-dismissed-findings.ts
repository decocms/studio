import { type Kysely, sql } from "kysely";

/**
 * Dismissed diagnostic findings — the tombstone that makes deleting a
 * reports-pushed card stick.
 *
 * The import identifies a finding by `task_board_items.external_key` and
 * refreshes the matching OPEN card instead of duplicating it (migration 136).
 * A deleted card matches nothing, so without a tombstone the next diagnostic
 * run for the same domain re-creates it — deleting a finding would silently
 * undo itself on the next scan.
 *
 * One row per (org, finding) the org has deleted. The import skips these keys
 * entirely and reports how many it skipped. `TASK_BOARD_DISMISSED_RESTORE`
 * clears rows, after which the finding is pushed again on the next run.
 *
 * PK (organization_id, external_key) is the dedup — a finding deleted twice
 * (deleted, restored, re-imported, deleted again) keeps its first
 * `dismissed_by`/`dismissed_at` via `on conflict do nothing`.
 *
 * Human-created cards have `external_key = null` and are never tombstoned.
 *
 * down() drops the table, which un-suppresses everything — the recoverable
 * direction (a finding reappears; nothing is lost).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_dismissed_findings")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("external_key", "text", (col) => col.notNull())
    .addColumn("dismissed_by", "text", (col) => col.notNull())
    .addColumn("dismissed_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_dismissed_findings_pkey", [
      "organization_id",
      "external_key",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_dismissed_findings").execute();
}
