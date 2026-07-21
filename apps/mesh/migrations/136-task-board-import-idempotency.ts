import { type Kysely, sql } from "kysely";

/**
 * Two idempotency keys for the task-board import (the diagnostic worker's
 * batch push — see api/routes/task-board-import.ts):
 *
 * 1. `task_board_import_runs` — one row per processed import request,
 *    PK (organization_id, run_id). The import claims the row up front inside
 *    its transaction; losing the claim means the same run was already
 *    imported, so a replay (the payment success page and the Stripe webhook
 *    fire seconds apart on the reports side) is a no-op instead of a 2×
 *    board.
 *
 * 2. `task_board_items.external_key` — the FINDING's identity, minted by the
 *    sender (e.g. `diag:{domain}:{check_id}:{scope}`). A re-import whose key
 *    matches an OPEN item refreshes it instead of creating a duplicate —
 *    recurring diagnostic runs converge on the same card. Non-unique on
 *    purpose: a done item keeps its key, and a regression legitimately
 *    creates a fresh open card with the same key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_import_runs")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("run_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_import_runs_pkey", [
      "organization_id",
      "run_id",
    ])
    .execute();

  await db.schema
    .alterTable("task_board_items")
    .addColumn("external_key", "text")
    .execute();

  await db.schema
    .createIndex("idx_task_board_items_org_external_key")
    .on("task_board_items")
    .columns(["organization_id", "external_key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_items_org_external_key").execute();
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("external_key")
    .execute();
  await db.schema.dropTable("task_board_import_runs").execute();
}
