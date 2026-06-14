import { type Kysely, sql } from "kysely";

/**
 * telos_goal — append-only, org-scoped goal ledger for the telos engine
 * (@decocms/telos). One lineage per organization; a goal "changes" only by
 * appending a new immutable version. `source` distinguishes the fixed anchor
 * ("authority") from engine-proposed subordinate goals ("engine").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("telos_goal")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("organization_id", "text", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("target", "jsonb", (c) => c.notNull())
    .addColumn("created_by", "text")
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("telos_goal_org_version_idx")
    .on("telos_goal")
    .columns(["organization_id", "version"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("telos_goal").execute();
}
