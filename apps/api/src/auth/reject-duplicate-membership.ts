import { type Kysely, sql } from "kysely";
import { APIError } from "better-auth/api";
import type { Database } from "../storage/types";

/**
 * Better Auth's accept-invitation creates a member without checking for an
 * existing one. Refuse it for a user who joined another way, and mark the
 * invitation accepted so it stops being offered: its outcome already holds.
 */
export async function rejectDuplicateMembership(
  db: Kysely<Database>,
  invitation: { id: string; organizationId: string },
  userId: string,
): Promise<void> {
  const existing = await db
    .selectFrom("member")
    .select("id")
    .where("organizationId", "=", invitation.organizationId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!existing) return;

  await sql`
    UPDATE "invitation" SET status = 'accepted'
    WHERE id = ${invitation.id} AND status = 'pending'
  `.execute(db);
  throw new APIError("BAD_REQUEST", {
    message: "User is already a member of this organization",
  });
}
