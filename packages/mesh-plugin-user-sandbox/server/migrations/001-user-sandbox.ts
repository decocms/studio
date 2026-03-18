/**
 * User Sandbox Plugin - Database Schema
 *
 * Creates tables for:
 * - user_sandbox: Template definitions with required apps and completion config
 * - user_sandbox_sessions: Per-user session state for the connect flow
 * - user_sandbox_agents: Links (template, external_user_id) to Virtual MCP (unique constraint)
 */

import { Kysely, sql } from "kysely";
import type { ServerPluginMigration } from "@decocms/bindings/server-plugin";

export const migration: ServerPluginMigration = {
  name: "001-user-sandbox",

  async up(db: Kysely<unknown>): Promise<void> {
    // User Sandbox table
    // Defines a template that platforms can use to create integration flows
    await db.schema
      .createTable("user_sandbox")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("organization_id", "text", (col) =>
        col.notNull().references("organization.id").onDelete("cascade"),
      )
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("description", "text")
      .addColumn("icon", "text")
      // Required apps from registry (JSON array)
      // Format: [{ app_name: "@deco/gmail", selected_tools: ["send_email"], ... }]
      .addColumn("required_apps", "text", (col) => col.notNull())
      // Completion configuration
      .addColumn("redirect_url", "text")
      .addColumn("webhook_url", "text")
      .addColumn("event_type", "text", (col) =>
        col.notNull().defaultTo("integration.completed"),
      )
      // Agent configuration
      .addColumn("agent_title_template", "text", (col) =>
        col.notNull().defaultTo("Agent for {{externalUserId}}"),
      )
      .addColumn("agent_instructions", "text")
      .addColumn("tool_selection_mode", "text", (col) =>
        col.notNull().defaultTo("inclusion"),
      )
      // Status
      .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
      // Audit fields
      .addColumn("created_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn("updated_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn("created_by", "text", (col) =>
        col.references("user.id").onDelete("set null"),
      )
      .execute();

    // Index for listing templates by organization
    await db.schema
      .createIndex("idx_user_sandbox_org")
      .on("user_sandbox")
      .column("organization_id")
      .execute();

    // User Sandbox Sessions table
    // Tracks per-user state during the connect flow
    await db.schema
      .createTable("user_sandbox_sessions")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("template_id", "text", (col) =>
        col.notNull().references("user_sandbox.id").onDelete("cascade"),
      )
      .addColumn("organization_id", "text", (col) =>
        col.notNull().references("organization.id").onDelete("cascade"),
      )
      // External user ID from the platform's system
      .addColumn("external_user_id", "text", (col) => col.notNull())
      // Session state
      .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
      // Per-app configuration status (JSON)
      // Format: { "@deco/gmail": { configured: true, connection_id: "conn_xxx" }, ... }
      .addColumn("app_statuses", "text", (col) => col.notNull().defaultTo("{}"))
      // Created agent ID (set on completion)
      .addColumn("created_agent_id", "text", (col) =>
        col.references("connections.id").onDelete("set null"),
      )
      // Snapshot of redirect_url from template at session creation
      .addColumn("redirect_url", "text")
      // Audit fields
      .addColumn("created_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn("updated_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      // Session expiration (default 7 days from creation)
      .addColumn("expires_at", "text", (col) => col.notNull())
      .execute();

    // Index for finding sessions by template
    await db.schema
      .createIndex("idx_user_sandbox_sessions_template")
      .on("user_sandbox_sessions")
      .column("template_id")
      .execute();

    // Index for finding sessions by external user within a template
    await db.schema
      .createIndex("idx_user_sandbox_sessions_external_user")
      .on("user_sandbox_sessions")
      .columns(["template_id", "external_user_id"])
      .execute();

    // Index for finding sessions by organization
    await db.schema
      .createIndex("idx_user_sandbox_sessions_org")
      .on("user_sandbox_sessions")
      .column("organization_id")
      .execute();

    // User Sandbox Agents table
    // Enforces one Virtual MCP (connection) per (template, external_user_id) pair
    // Prevents race conditions when concurrent requests create agents for the same user
    await db.schema
      .createTable("user_sandbox_agents")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("user_sandbox_id", "text", (col) =>
        col.notNull().references("user_sandbox.id").onDelete("cascade"),
      )
      .addColumn("external_user_id", "text", (col) => col.notNull())
      .addColumn("connection_id", "text", (col) =>
        col.notNull().references("connections.id").onDelete("cascade"),
      )
      .addColumn("created_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .execute();

    // UNIQUE constraint on (user_sandbox_id, external_user_id)
    // This prevents duplicate Virtual MCPs for the same user
    await db.schema
      .createIndex("idx_user_sandbox_agents_unique")
      .on("user_sandbox_agents")
      .columns(["user_sandbox_id", "external_user_id"])
      .unique()
      .execute();

    // Index for looking up agents by connection
    await db.schema
      .createIndex("idx_user_sandbox_agents_connection")
      .on("user_sandbox_agents")
      .column("connection_id")
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    // Drop indexes first
    await db.schema
      .dropIndex("idx_user_sandbox_agents_connection")
      .ifExists()
      .execute();
    await db.schema
      .dropIndex("idx_user_sandbox_agents_unique")
      .ifExists()
      .execute();
    await db.schema
      .dropIndex("idx_user_sandbox_sessions_org")
      .ifExists()
      .execute();
    await db.schema
      .dropIndex("idx_user_sandbox_sessions_external_user")
      .ifExists()
      .execute();
    await db.schema
      .dropIndex("idx_user_sandbox_sessions_template")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_user_sandbox_org").ifExists().execute();

    // Drop tables (agents and sessions first due to FK constraints)
    await db.schema.dropTable("user_sandbox_agents").ifExists().execute();
    await db.schema.dropTable("user_sandbox_sessions").ifExists().execute();
    await db.schema.dropTable("user_sandbox").ifExists().execute();
  },
};
