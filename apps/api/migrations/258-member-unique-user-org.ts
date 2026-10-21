import { type Kysely, sql } from "kysely";

/**
 * One membership row per user and organization.
 *
 * Better Auth's accept-invitation inserts a member without checking for an
 * existing one, so a user added another way who later accepted a still-pending
 * invite ended up with two rows, and the org appeared twice wherever members
 * are joined. Keep each pair's oldest row, then let the unique index reject
 * the next duplicate. It replaces the plain index on the same columns.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM "member" AS m
    USING (
      SELECT id, row_number() OVER (
        PARTITION BY "userId", "organizationId"
        ORDER BY "createdAt", id
      ) AS rank
      FROM "member"
    ) AS ranked
    WHERE m.id = ranked.id AND ranked.rank > 1
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_user_org_unique
      ON "member" ("userId", "organizationId")
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_member_user_org`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_member_user_org
      ON "member" ("userId", "organizationId")
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_member_user_org_unique`.execute(db);
}
