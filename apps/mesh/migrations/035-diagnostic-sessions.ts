/**
 * Diagnostic Sessions Migration
 *
 * Creates the diagnostic_sessions table for storing storefront diagnostic scan
 * results with progressive status updates per agent. Sessions are pre-auth —
 * organization_id and project_id are nullable and filled retroactively post-login.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create diagnostic_sessions table
  // NOTE: organization_id and project_id are nullable — sessions start pre-auth
  // and are retroactively associated after login (Phase 21).
  await db.schema
    .createTable("diagnostic_sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("normalized_url", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("agents", "text", (col) => col.notNull()) // JSON: Record<DiagnosticAgentId, AgentStatus>
    .addColumn("results", "text", (col) => col.notNull().defaultTo("{}")) // JSON: DiagnosticResult
    .addColumn("organization_id", "text", (col) =>
      col.references("organization.id").onDelete("set null"),
    )
    .addColumn("project_id", "text", (col) =>
      col.references("projects.id").onDelete("set null"),
    )
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();

  // Index for unique token lookups (poll endpoint)
  await db.schema
    .createIndex("diagnostic_sessions_token")
    .on("diagnostic_sessions")
    .columns(["token"])
    .execute();

  // Index for cache lookups by normalized URL
  await db.schema
    .createIndex("diagnostic_sessions_normalized_url")
    .on("diagnostic_sessions")
    .columns(["normalized_url"])
    .execute();

  // Index for org association queries
  await db.schema
    .createIndex("diagnostic_sessions_org")
    .on("diagnostic_sessions")
    .columns(["organization_id"])
    .execute();

  // Index for TTL cleanup queries
  await db.schema
    .createIndex("diagnostic_sessions_expires")
    .on("diagnostic_sessions")
    .columns(["expires_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("diagnostic_sessions_expires").execute();
  await db.schema.dropIndex("diagnostic_sessions_org").execute();
  await db.schema.dropIndex("diagnostic_sessions_normalized_url").execute();
  await db.schema.dropIndex("diagnostic_sessions_token").execute();

  // Drop table
  await db.schema.dropTable("diagnostic_sessions").execute();
}
