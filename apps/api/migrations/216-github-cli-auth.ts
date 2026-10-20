import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE git_provider_accounts
    DROP CONSTRAINT git_provider_accounts_auth_kind_check,
    ADD CONSTRAINT git_provider_accounts_auth_kind_check
      CHECK (auth_kind IN ('github_app', 'oauth', 'token', 'github_cli')),
    ADD CONSTRAINT git_provider_accounts_cli_check
      CHECK (auth_kind <> 'github_cli' OR
        (type = 'github' AND host = 'github.com' AND installation_id IS NULL))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ON DELETE SET NULL preserves linked repositories as anonymous clones.
  await sql`DELETE FROM git_provider_accounts WHERE auth_kind = 'github_cli'`.execute(
    db,
  );
  await sql`ALTER TABLE git_provider_accounts
    DROP CONSTRAINT git_provider_accounts_cli_check,
    DROP CONSTRAINT git_provider_accounts_auth_kind_check,
    ADD CONSTRAINT git_provider_accounts_auth_kind_check
      CHECK (auth_kind IN ('github_app', 'oauth', 'token'))`.execute(db);
}
