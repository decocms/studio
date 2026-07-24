/**
 * First-class lifecycle registry for shared hosted sandboxes.
 *
 * virtual_mcp_id intentionally has no foreign key: the well-known Decopilot
 * virtual MCP is synthetic and still owns thread-scoped sandboxes.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_sandbox_sessions")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("virtual_mcp_id", "text", (col) => col.notNull())
    .addColumn("branch", "text", (col) => col.notNull())
    .addColumn("thread_id", "text")
    .addColumn("sandbox_handle", "text")
    .addColumn("preview_url", "text")
    .addColumn("sandbox_api_url", "text")
    .addColumn("desired_state", "text", (col) =>
      col.notNull().defaultTo("running"),
    )
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo("provisioning"),
    )
    .addColumn("generation", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("started_with", "jsonb")
    .addColumn("failure_reason", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("last_started_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("agent_sandbox_sessions_pkey", [
      "organization_id",
      "virtual_mcp_id",
      "branch",
    ])
    .addCheckConstraint(
      "agent_sandbox_sessions_desired_state_check",
      sql`desired_state in ('running', 'stopped')`,
    )
    .addCheckConstraint(
      "agent_sandbox_sessions_status_check",
      sql`status in ('provisioning', 'ready', 'missing', 'failed', 'stopping', 'reaping', 'deleting', 'stopped')`,
    )
    .execute();

  await db.schema
    .createIndex("agent_sandbox_sessions_vm_updated_idx")
    .on("agent_sandbox_sessions")
    .columns(["organization_id", "virtual_mcp_id", "updated_at"])
    .execute();

  await db.schema
    .createIndex("agent_sandbox_sessions_thread_idx")
    .on("agent_sandbox_sessions")
    .columns(["organization_id", "thread_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_sandbox_sessions").execute();
}
