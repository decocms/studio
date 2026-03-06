/**
 * Add dependency_mode column to connection_aggregations
 *
 * This column tracks how a connection is related to a Virtual MCP:
 * - 'direct': User explicitly added this connection to the Virtual MCP
 * - 'indirect': Connection is referenced by virtual tool code (FK prevents deletion)
 *
 * Direct dependencies have their tools exposed in the Virtual MCP's tool list.
 * Indirect dependencies exist only to enforce FK constraints - their tools are
 * NOT exposed, but are called internally by virtual tool code.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add dependency_mode column with default 'direct' for existing rows
  // SQLite and PostgreSQL both support this syntax
  await sql`
    ALTER TABLE connection_aggregations 
    ADD COLUMN dependency_mode TEXT NOT NULL DEFAULT 'direct'
  `.execute(db);

  // Create index for efficient filtering by dependency_mode
  await db.schema
    .createIndex("idx_conn_agg_dependency_mode")
    .on("connection_aggregations")
    .columns(["parent_connection_id", "dependency_mode"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the index first
  await db.schema.dropIndex("idx_conn_agg_dependency_mode").execute();

  // Drop the column
  await sql`ALTER TABLE connection_aggregations DROP COLUMN dependency_mode`.execute(
    db,
  );
}
