import { type Kysely, sql } from "kysely";

/**
 * A third git provider kind, Bitbucket Cloud. The three `type`/`provider`
 * columns were created with inline CHECK constraints naming the two kinds of
 * the day, so each is re-stated with the third. The auto-generated names are
 * Postgres's `<table>_<column>_check`.
 */

const CONSTRAINTS = [
  { table: "git_provider_accounts", column: "type" },
  { table: "git_provider_oauth_states", column: "provider" },
  { table: "repositories", column: "provider" },
] as const;

async function restate(
  db: Kysely<unknown>,
  kinds: readonly string[],
): Promise<void> {
  for (const { table, column } of CONSTRAINTS) {
    const name = `${table}_${column}_check`;
    const list = kinds.map((kind) => `'${kind}'`).join(", ");
    await sql
      .raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`)
      .execute(db);
    await sql
      .raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${column} IN (${list}))`,
      )
      .execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await restate(db, ["github", "gitlab", "bitbucket"]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rows of the new kind would violate the narrower check; remove them first
  // (repositories cascade from their account, oauth states are transient).
  await sql`DELETE FROM repositories WHERE provider = 'bitbucket'`.execute(db);
  await sql`DELETE FROM git_provider_oauth_states WHERE provider = 'bitbucket'`.execute(
    db,
  );
  await sql`DELETE FROM git_provider_accounts WHERE type = 'bitbucket'`.execute(
    db,
  );
  await restate(db, ["github", "gitlab"]);
}
