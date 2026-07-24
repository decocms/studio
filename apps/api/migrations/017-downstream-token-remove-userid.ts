/**
 * Migration 017: Remove userId from downstream_tokens
 *
 * Makes OAuth tokens connection-scoped instead of user-scoped.
 * Tokens belong to connections, not individual users.
 *
 * Data migration: For connections with multiple tokens (from different users),
 * keeps only the most recently updated token.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Step 1: Delete duplicate tokens, keeping only the most recently updated per connectionId
  // This handles cases where multiple users had tokens for the same connection
  // Note: Column names must be quoted for PostgreSQL (camelCase)
  await sql`
    DELETE FROM downstream_tokens
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, "connectionId",
          ROW_NUMBER() OVER (PARTITION BY "connectionId" ORDER BY "updatedAt" DESC) as rn
        FROM downstream_tokens
      ) ranked
      WHERE rn = 1
    )
  `.execute(db);

  // Step 2: Drop the old composite index
  await db.schema.dropIndex("idx_downstream_tokens_connection_user").execute();

  // Step 3: Drop the userId column
  await db.schema
    .alterTable("downstream_tokens")
    .dropColumn("userId")
    .execute();

  // Step 4: Create unique index on connectionId (one token per connection)
  await db.schema
    .createIndex("idx_downstream_tokens_connection")
    .on("downstream_tokens")
    .column("connectionId")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the unique index
  await db.schema.dropIndex("idx_downstream_tokens_connection").execute();

  // Re-add userId column as nullable (data cannot be restored)
  await db.schema
    .alterTable("downstream_tokens")
    .addColumn("userId", "text")
    .execute();

  // Recreate the original composite index
  await db.schema
    .createIndex("idx_downstream_tokens_connection_user")
    .on("downstream_tokens")
    .columns(["connectionId", "userId"])
    .execute();
}
