/**
 * Initial Database Schema
 *
 * Creates all tables for Deco Studio:
 * - users (managed by Better Auth)
 * - connections (organization-scoped)
 * - api_keys (managed by Better Auth)
 * - audit_logs
 * - OAuth tables (oauth_clients, oauth_authorization_codes, oauth_refresh_tokens)
 * - downstream_tokens
 *
 * Note: Organizations, teams, members, and roles are managed by Better Auth organization plugin.
 * Run `bun run better-auth:migrate` to create those tables.
 */

import { Kysely, sql } from "kysely";

// Using unknown for database parameter as schema is being created
export async function up(db: Kysely<unknown>): Promise<void> {
  // MCP Connections table (organization-scoped)
  // CASCADE DELETE: When organization is deleted, connections are automatically removed
  await db.schema
    .createTable("connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organizationId", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("createdById", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("icon", "text")
    .addColumn("appName", "text")
    .addColumn("appId", "text")
    .addColumn("connectionType", "text", (col) => col.notNull())
    .addColumn("connectionUrl", "text", (col) => col.notNull())
    .addColumn("connectionToken", "text")
    .addColumn("connectionHeaders", "text")
    .addColumn("oauthConfig", "text")
    .addColumn("metadata", "text")
    .addColumn("tools", "text")
    .addColumn("bindings", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // API Keys table (Better Auth managed)
  await db.schema
    .createTable("api_keys")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("hashedKey", "text", (col) => col.notNull().unique())
    .addColumn("permissions", "text", (col) => col.notNull())
    .addColumn("expiresAt", "text")
    .addColumn("remaining", "integer")
    .addColumn("metadata", "text")
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Audit Logs table
  await db.schema
    .createTable("audit_logs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organizationId", "text") // nullable for system-level actions
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("connectionId", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("toolName", "text", (col) => col.notNull())
    .addColumn("allowed", "integer", (col) => col.notNull())
    .addColumn("duration", "integer")
    .addColumn("timestamp", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("requestMetadata", "text")
    .execute();

  // OAuth Clients table
  await db.schema
    .createTable("oauth_clients")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("clientId", "text", (col) => col.notNull().unique())
    .addColumn("clientSecret", "text")
    .addColumn("clientName", "text", (col) => col.notNull())
    .addColumn("redirectUris", "text", (col) => col.notNull())
    .addColumn("grantTypes", "text", (col) => col.notNull())
    .addColumn("scope", "text")
    .addColumn("clientUri", "text")
    .addColumn("logoUri", "text")
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // OAuth Authorization Codes table
  await db.schema
    .createTable("oauth_authorization_codes")
    .addColumn("code", "text", (col) => col.primaryKey())
    .addColumn("clientId", "text", (col) =>
      col.notNull().references("oauth_clients.clientId").onDelete("cascade"),
    )
    .addColumn("userId", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("redirectUri", "text", (col) => col.notNull())
    .addColumn("scope", "text")
    .addColumn("codeChallenge", "text")
    .addColumn("codeChallengeMethod", "text")
    .addColumn("expiresAt", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // OAuth Refresh Tokens table
  await db.schema
    .createTable("oauth_refresh_tokens")
    .addColumn("token", "text", (col) => col.primaryKey())
    .addColumn("clientId", "text", (col) =>
      col.notNull().references("oauth_clients.clientId").onDelete("cascade"),
    )
    .addColumn("userId", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("scope", "text")
    .addColumn("expiresAt", "text")
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Downstream Tokens table
  await db.schema
    .createTable("downstream_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connectionId", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("cascade"),
    )
    .addColumn("accessToken", "text", (col) => col.notNull())
    .addColumn("refreshToken", "text")
    .addColumn("scope", "text")
    .addColumn("expiresAt", "text")
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Create indexes for better query performance
  await db.schema
    .createIndex("idx_connections_organizationId")
    .on("connections")
    .column("organizationId")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_organizationId")
    .on("audit_logs")
    .column("organizationId")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_userId")
    .on("audit_logs")
    .column("userId")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_timestamp")
    .on("audit_logs")
    .column("timestamp")
    .execute();
}

// Using unknown for database parameter as schema is being dropped
export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop tables in reverse order (respecting foreign keys)
  await db.schema.dropTable("downstream_tokens").execute();
  await db.schema.dropTable("oauth_refresh_tokens").execute();
  await db.schema.dropTable("oauth_authorization_codes").execute();
  await db.schema.dropTable("oauth_clients").execute();
  await db.schema.dropTable("audit_logs").execute();
  await db.schema.dropTable("api_keys").execute();
  await db.schema.dropTable("connections").execute();
}
