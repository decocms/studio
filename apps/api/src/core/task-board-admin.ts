/**
 * Who may read and act across every org's task board.
 *
 * One predicate, one place. Granting it takes a deploy (`STUDIO_ADMIN_ORG_IDS`),
 * which is the right amount of friction for "read every tenant's data".
 *
 * Deliberately NOT unioned with `DEPLOYMENT_ADMIN_EMAILS`: that allowlist is
 * per-human and gates /api/_admin. Two answers to "who is an admin" is already
 * one too many; silently unioning them is how the third appears.
 */

import type { Kysely } from "kysely";
import { getSettings } from "@/settings";
import type { Database } from "@/storage/types";

/**
 * Is this user a member of ANY admin org? Empty `STUDIO_ADMIN_ORG_IDS` = nobody.
 *
 * The org in the URL is the org being *acted on*, so membership of the admin
 * org has to be looked up separately — it is never the path org.
 */
export async function isTaskBoardAdminUser(
  db: Kysely<Database>,
  userId: string | undefined,
): Promise<boolean> {
  const adminOrgIds = getSettings().taskBoardAdminOrgIds;
  if (!userId || adminOrgIds.length === 0) return false;
  const row = await db
    .selectFrom("member")
    .select(["id"])
    .where("userId", "=", userId)
    .where("organizationId", "in", adminOrgIds)
    .executeTakeFirst();
  return !!row;
}

/**
 * The same question from inside a tool. Re-derived per call on purpose: a task
 * delegated while the feature was on must not keep cross-org power after the
 * org is removed from the env var.
 */
export async function isTaskBoardAdminCtx(ctx: {
  db?: Kysely<Database> | undefined;
  auth?: { user?: { id?: string } | null } | null;
}): Promise<boolean> {
  if (!ctx.db) return false;
  return isTaskBoardAdminUser(ctx.db, ctx.auth?.user?.id);
}

/** One audit line per cross-org access. Same shape as `deployment_admin_action`. */
export function auditTaskBoardAdminAction(props: {
  action: string;
  actorUserId: string | undefined;
  actorOrgId?: string | undefined;
  targetOrgId: string | undefined;
  [key: string]: unknown;
}): void {
  console.log("task_board_admin_action", props);
}
