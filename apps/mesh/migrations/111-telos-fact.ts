import { type Kysely, sql } from "kysely";

// telos_fact — tentative findings from onboarding research. status is
// proposed | confirmed | rejected; the user curates them.
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
