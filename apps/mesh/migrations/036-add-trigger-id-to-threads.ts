import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("trigger_id", "text", (col) =>
      col.references("triggers.id").onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("idx_threads_trigger_id")
    .on("threads")
    .column("trigger_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_threads_trigger_id").execute();
  await db.schema.alterTable("threads").dropColumn("trigger_id").execute();
}
