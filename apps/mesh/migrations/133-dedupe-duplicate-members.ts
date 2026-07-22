import { sql, type Kysely } from "kysely";

/**
 * Removes duplicate organization membership rows.
 *
 * A user could end up with two `member` rows in the same org: domain auto-join
 * at signup created one, then accepting the pending invitation created another
 * (Better Auth's acceptInvitation calls createMember unconditionally, without
 * an existing-member check). The signup-side fix now skips the auto-join when a
 * pending invitation governs membership; this migration cleans up rows already
 * created before that fix.
 *
 * Per (organizationId, userId) we keep a single row, preferring: a privileged
 * role (owner > admin) so we never demote someone, then the row carrying the
 * most tags (member_tags cascades on delete, so a discarded row must not be the
 * one holding a user's tags), then the earliest createdAt, then the smallest id
 * for a deterministic tiebreak. Everything else in the group is deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM member
    WHERE id IN (
      SELECT id FROM (
        SELECT
          m.id,
          row_number() OVER (
            PARTITION BY m."organizationId", m."userId"
            ORDER BY
              (m.role = 'owner') DESC,
              (m.role = 'admin') DESC,
              (SELECT count(*) FROM member_tags mt WHERE mt.member_id = m.id) DESC,
              m."createdAt" ASC,
              m.id ASC
          ) AS rn
        FROM member m
      ) ranked
      WHERE ranked.rn > 1
    )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No rollback — the deleted rows were accidental duplicates and the surviving
  // row already represents the membership.
}
