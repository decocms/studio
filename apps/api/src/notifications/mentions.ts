/**
 * Fan-out for `@`-mentions written into a task description or a comment.
 *
 * Only NEW mentions notify: editing a description re-sends its whole body, so
 * without the diff every typo fix would re-ping everyone already named in it.
 *
 * The ids come out of user-authored markdown, so they are input, not fact:
 * membership of THIS org is checked here before anything is written. Skipping
 * that would turn a hand-written body into a way to notify any user id in the
 * deployment.
 */

import type { Kysely } from "kysely";
import { parseMentions } from "@decocms/shared/mentions";
import type { Database } from "@/storage/types";
import { notify } from "./notify";

export interface NotifyMentionsParams {
  db: Kysely<Database>;
  taskBoardItemId: string;
  organizationId: string;
  /** Null = agent/system. Never notified of its own mention. */
  actorId: string | null;
  /** The body as saved. */
  body: string;
  /** The body before this edit, if it's an edit. Mentions already in it are
   *  not re-notified. */
  previousBody?: string | null;
}

/** Never throws — like `notify`, a failed ping must not fail the write that
 *  earned it. */
export async function notifyMentions(
  params: NotifyMentionsParams,
): Promise<void> {
  const { db, organizationId, actorId } = params;
  try {
    const before = new Set(parseMentions(params.previousBody ?? ""));
    const fresh = parseMentions(params.body).filter((id) => !before.has(id));
    const candidates = fresh.filter((id) => id !== actorId);
    if (candidates.length === 0) return;

    const members = await db
      .selectFrom("member")
      .select("userId")
      .where("organizationId", "=", organizationId)
      .where("userId", "in", candidates)
      .execute();
    const recipients = members.map((m) => m.userId);
    if (recipients.length === 0) return;

    await notify({
      db,
      taskBoardItemId: params.taskBoardItemId,
      type: "mentioned",
      actorId,
      // Being named on a task is enrolment in it — the same way commenting is.
      alsoSubscribe: recipients,
      recipients,
    });
  } catch (err) {
    console.error("[notifications] mention fan-out failed", err);
  }
}
