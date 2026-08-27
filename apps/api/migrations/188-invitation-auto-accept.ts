import { type Kysely, sql } from "kysely";

/**
 * Marks an invitation as safe to claim on the invitee's behalf at signup.
 *
 * Default false: a normal invitation must still be accepted deliberately, so
 * inviting an arbitrary address cannot silently place that person in an org the
 * first time they sign up. Only trusted bulk backfills (migrating members from
 * a prior system, where the membership already existed) set this true.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE invitation
      ADD COLUMN "autoAccept" boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE invitation DROP COLUMN "autoAccept"`.execute(db);
}
