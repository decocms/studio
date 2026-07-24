/**
 * Migration 015: Add client registration info to downstream_tokens
 *
 * Adds clientId and clientSecret columns to support Dynamic Client Registration
 * and token refresh for downstream MCP OAuth flows.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add clientId and clientSecret for Dynamic Client Registration
  await db.schema
    .alterTable("downstream_tokens")
    .addColumn("clientId", "text")
    .execute();

  await db.schema
    .alterTable("downstream_tokens")
    .addColumn("clientSecret", "text")
    .execute();

  // Add tokenEndpoint to know where to refresh
  await db.schema
    .alterTable("downstream_tokens")
    .addColumn("tokenEndpoint", "text")
    .execute();

  // Create index for faster lookups by connectionId + userId
  await db.schema
    .createIndex("idx_downstream_tokens_connection_user")
    .on("downstream_tokens")
    .columns(["connectionId", "userId"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_downstream_tokens_connection_user").execute();

  await db.schema
    .alterTable("downstream_tokens")
    .dropColumn("tokenEndpoint")
    .execute();

  await db.schema
    .alterTable("downstream_tokens")
    .dropColumn("clientSecret")
    .execute();

  await db.schema
    .alterTable("downstream_tokens")
    .dropColumn("clientId")
    .execute();
}
