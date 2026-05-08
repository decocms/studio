/**
 * Persistent sandbox runner state — survives mesh restarts so we can
 * recover or terminate live sandboxes. `state` jsonb is opaque: each
 * runner serialises its own shape (docker: {token, hostPort, ...};
 * freestyle: {token, domain, ...}).
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sandbox_runner_state")
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("project_ref", "text", (col) => col.notNull())
    .addColumn("runner_kind", "text", (col) => col.notNull())
    .addColumn("handle", "text", (col) => col.notNull())
    .addColumn("state", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo("now()"),
    )
    .addPrimaryKeyConstraint("sandbox_runner_state_pkey", [
      "user_id",
      "project_ref",
      "runner_kind",
    ])
    .execute();

  await db.schema
    .createIndex("sandbox_runner_state_handle_idx")
    .on("sandbox_runner_state")
    .column("handle")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sandbox_runner_state").execute();
}
