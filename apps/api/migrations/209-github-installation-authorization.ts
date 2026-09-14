import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Historical connections only proved repository access, not installation ownership.
  // Leave them unverified so reconnect performs the new ownership check.
  await db.schema
    .alterTable("git_provider_accounts")
    .addColumn("installation_authorized_by", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("git_provider_accounts")
    .dropColumn("installation_authorized_by")
    .execute();
}
