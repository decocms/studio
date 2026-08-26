import { type Kysely, sql } from "kysely";

/** Migration 177's notification type list, plus `mentioned` — written when a
 *  task description or comment `@`s a member. The CHECK constraint is replaced
 *  wholesale: 177 may already be live, so editing its list in place wouldn't
 *  reach a deployed database. A frozen snapshot like its predecessor;
 *  `notification-types.test.ts` reads this one (the newest) to prove SQL and
 *  TypeScript agree. */
export const TYPES = [
  "created",
  "commented",
  "mentioned",
  "status_changed",
  "assignee_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_failed",
] as const;

const NEW_TYPES = new Set<string>(["mentioned"]);

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceNotificationTypeCheck(db, TYPES);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceNotificationTypeCheck(
    db,
    TYPES.filter((t) => !NEW_TYPES.has(t)),
  );
}

/** Swap `notifications`' type CHECK constraint for one allowing exactly
 *  `types`. */
async function replaceNotificationTypeCheck(
  db: Kysely<unknown>,
  types: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE notifications DROP CONSTRAINT notifications_type_check`.execute(
    db,
  );
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (${sql.join(
    types.map((t) => sql.lit(t)),
  )}))`.execute(db);
}
