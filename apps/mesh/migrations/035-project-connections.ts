/**
 * Project Connections Migration
 *
 * Creates the project_connections join table for associating
 * organization connections with specific projects.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("project_connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("project_connections_project_conn_unique")
    .on("project_connections")
    .columns(["project_id", "connection_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("project_connections_project_id_idx")
    .on("project_connections")
    .columns(["project_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("project_connections_project_id_idx").execute();
  await db.schema
    .dropIndex("project_connections_project_conn_unique")
    .execute();
  await db.schema.dropTable("project_connections").execute();
}
