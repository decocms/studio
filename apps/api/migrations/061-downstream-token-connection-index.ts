/**
 * Add unique index on downstream_tokens.connectionId
 *
 * This column is queried on every outbound MCP request (hot path)
 * but had no index, causing full table scans under load.
 * The relationship is 1:1 (one token per connection), so a unique index is appropriate.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_downstream_tokens_connectionId")
    .ifNotExists()
    .on("downstream_tokens")
    .column("connectionId")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("idx_downstream_tokens_connectionId")
    .ifExists()
    .execute();
}
