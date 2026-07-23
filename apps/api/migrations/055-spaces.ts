import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add pinned column
  await db.schema
    .alterTable("connections")
    .addColumn("pinned", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();

  // Backfill: projects become pinned, agents/null become unpinned
  await sql`UPDATE connections SET pinned = true WHERE subtype = 'project' AND connection_type = 'VIRTUAL'`.execute(
    db,
  );

  // Drop the old composite index on (organization_id, connection_type, subtype)
  await db.schema
    .dropIndex("idx_connections_org_type_subtype")
    .ifExists()
    .execute();

  // Drop the CHECK constraint on subtype
  await sql`ALTER TABLE connections DROP CONSTRAINT IF EXISTS chk_connections_subtype`.execute(
    db,
  );

  // Drop the subtype column
  await db.schema.alterTable("connections").dropColumn("subtype").execute();

  // Add new composite index for pinned queries
  await db.schema
    .createIndex("idx_connections_org_type_pinned")
    .on("connections")
    .columns(["organization_id", "connection_type", "pinned"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop new index
  await db.schema
    .dropIndex("idx_connections_org_type_pinned")
    .ifExists()
    .execute();

  // Re-add subtype column
  await db.schema
    .alterTable("connections")
    .addColumn("subtype", "text")
    .execute();

  // Backfill: pinned items become projects, unpinned become agents
  await sql`UPDATE connections SET subtype = 'project' WHERE pinned = true AND connection_type = 'VIRTUAL'`.execute(
    db,
  );
  await sql`UPDATE connections SET subtype = 'agent' WHERE pinned = false AND connection_type = 'VIRTUAL'`.execute(
    db,
  );

  // Re-add CHECK constraint
  await sql`ALTER TABLE connections ADD CONSTRAINT chk_connections_subtype CHECK (subtype IN ('agent', 'project') OR subtype IS NULL)`.execute(
    db,
  );

  // Re-add old index
  await db.schema
    .createIndex("idx_connections_org_type_subtype")
    .on("connections")
    .columns(["organization_id", "connection_type", "subtype"])
    .execute();

  // Drop pinned column
  await db.schema.alterTable("connections").dropColumn("pinned").execute();
}
