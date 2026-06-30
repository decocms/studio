import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("projected_seq").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("projected_seq", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
}
