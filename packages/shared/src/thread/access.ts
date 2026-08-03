/**
 * Thread write-access rules.
 *
 * A thread is owned by its creator (`created_by`). By default only the owner may
 * send messages into it — every other org member sees it read-only. The one
 * exception: while a thread is paused awaiting human input (`requires_action` —
 * e.g. a QA Agent or Code Reviewer asked a question via `user_ask`), ANY
 * authenticated org member may answer, so the run isn't blocked on a single
 * person.
 *
 * Org membership is enforced upstream (org-scoped routes + org-scoped thread
 * fetch), so this decision is purely about ownership vs. the awaiting-input
 * exception — it never widens access beyond the org.
 */

import type { ThreadDisplayStatus } from "../entities.ts";

export function canRespondToThread(params: {
  createdBy: string | null | undefined;
  userId: string | null | undefined;
  status: ThreadDisplayStatus | null | undefined;
}): boolean {
  const { createdBy, userId, status } = params;
  // Fall back to permissive when either id is unknown — mirrors the prior
  // frontend guard, which only blocked once both ids were known and differed.
  if (!createdBy || !userId) return true;
  if (createdBy === userId) return true;
  // Non-owner: allowed only while the thread is paused awaiting input.
  return status === "requires_action";
}
