/**
 * Runner-private persistence for shared hosted sandboxes.
 *
 * The existing sandbox_runner_state remains user-scoped for user-desktop and
 * legacy hosted claims. New shared agent-sandbox claims are keyed only by the
 * project ref (which already includes org, virtual MCP, and branch).
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_sandbox_runner_state")
    .addColumn("project_ref", "text", (col) => col.notNull())
    .addColumn("sandbox_provider_kind", "text", (col) => col.notNull())
    .addColumn("handle", "text", (col) => col.notNull())
    .addColumn("state", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("agent_sandbox_runner_state_pkey", [
      "project_ref",
      "sandbox_provider_kind",
    ])
    .execute();

  await db.schema
    .createIndex("agent_sandbox_runner_state_handle_idx")
    .on("agent_sandbox_runner_state")
    .column("handle")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_sandbox_runner_state").execute();
}
