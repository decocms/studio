import { type Kysely, sql } from "kysely";

/**
 * telos_fact — tentative findings the elenchus uncovered about an org's owner
 * during onboarding research. They are PROPOSED, not asserted: the user confirms
 * or rejects each one, so `status` carries the dialectic ("proposed" → the
 * person half-knew it, "confirmed" → recollected/agreed, "rejected" → refuted).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("telos_fact")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("organization_id", "text", (c) => c.notNull())
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("confidence", "text", (c) => c.notNull()) // low | medium | high
    .addColumn("status", "text", (c) => c.notNull().defaultTo("proposed"))
    .addColumn("source_url", "text")
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("telos_fact_org_idx")
    .on("telos_fact")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("telos_fact").execute();
}
