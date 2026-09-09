import type { Kysely } from "kysely";

/**
 * The repositories of a GitHub installation an organization was granted.
 *
 * Null keeps the meaning `209` gave the account: the installation's own owner
 * authorized it, whole. A list is the narrower grant somebody who only
 * administers part of the account can hand over.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("git_provider_accounts")
    .addColumn("installation_repository_ids", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("git_provider_accounts")
    .dropColumn("installation_repository_ids")
    .execute();
}
