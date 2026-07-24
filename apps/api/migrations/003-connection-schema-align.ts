/**
 * Connection Schema Alignment Migration
 *
 * Renames columns in the connections table to match ConnectionEntitySchema:
 * - camelCase → snake_case
 * - name → title (to match BaseCollectionEntitySchema convention)
 *
 * This eliminates the need for connectionToEntity transformation.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Rename columns to snake_case and align with entity schema
  await db.schema
    .alterTable("connections")
    .renameColumn("name", "title")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("createdById", "created_by")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("createdAt", "created_at")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("updatedAt", "updated_at")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("organizationId", "organization_id")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connectionType", "connection_type")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connectionUrl", "connection_url")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connectionToken", "connection_token")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connectionHeaders", "connection_headers")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("oauthConfig", "oauth_config")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("appName", "app_name")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("appId", "app_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Revert column names back to camelCase
  await db.schema
    .alterTable("connections")
    .renameColumn("title", "name")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("created_by", "createdById")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("created_at", "createdAt")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("updated_at", "updatedAt")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("organization_id", "organizationId")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connection_type", "connectionType")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connection_url", "connectionUrl")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connection_token", "connectionToken")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("connection_headers", "connectionHeaders")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("oauth_config", "oauthConfig")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("app_name", "appName")
    .execute();

  await db.schema
    .alterTable("connections")
    .renameColumn("app_id", "appId")
    .execute();
}
