import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_member_user_org")
    .ifNotExists()
    .on("member")
    .columns(["userId", "organizationId"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_member_user_org").execute();
}
