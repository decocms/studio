import { sql, type Kysely } from "kysely";

/**
 * Remove SSO providers registered through Better Auth's `/sso/register`,
 * which is now disabled. Operator providers live in `defaultSSO` and org SSO
 * in its own table, so every `ssoProvider` row came from that endpoint.
 * Sessions and account links they created go with them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM "session"
    WHERE "userId" IN (
      SELECT a."userId" FROM "account" a
      JOIN "ssoProvider" p ON p."providerId" = a."providerId"
    )
  `.execute(db);

  await sql`
    DELETE FROM "account"
    WHERE "providerId" IN (SELECT "providerId" FROM "ssoProvider")
  `.execute(db);

  await sql`DELETE FROM "ssoProvider"`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
