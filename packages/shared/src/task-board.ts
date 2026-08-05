/**
 * Sentinel `assigneeId` for the org's Super Agent (the well-known Decopilot
 * agent). Not a real member userId — `validate-assignee` skips membership for
 * it, and assigning it enqueues a Super Agent run on the task. Lives in
 * `@decocms/shared` so both the server tools and the web board can import it.
 */
export const SUPER_AGENT_ASSIGNEE_ID = "super-agent";

/**
 * True for a task pushed by the Reports import route (`created_by = "system"`,
 * the sentinel for non-user principals — see `apps/api/src/api/routes/
 * task-board-import.ts`). Its CONTENT (title/description/priority) is owned by
 * the reports sync, which refreshes it on open items, so both the write guard
 * (`TASK_BOARD_ITEM_UPDATE`) and the board UI (locking those fields) key off
 * this. Board interactions — status/drag, assignee (delegating IS how a run
 * starts), due date, tags — stay free.
 */
export function isReportsTask(item: { createdBy: string }): boolean {
  return item.createdBy === "system";
}

/**
 * The org's automated reviewers. Both are derived identities over the org's
 * agent runtime (never seeded), enabled per-org via `qa_agent_enabled` /
 * `code_reviewer_enabled` flags. When a Super Agent task reaches In Review with
 * passing/absent checks, a run is enqueued for each ENABLED reviewer — they're
 * not task assignees (the task stays with the Super Agent), they run as linked
 * review threads shown on the card.
 *
 * - `qa` — verifies the task actually solved the problem (exercises the feature).
 * - `code_review` — reviews the code with the repo's stack-appropriate skills.
 */
export type ReviewerKind = "qa" | "code_review";

export const REVIEWER_KINDS: ReviewerKind[] = ["qa", "code_review"];

/** Human label for a reviewer — also the prefix of its run thread's title
 *  (`"QA Agent: <task>"`), which is how the board tells the thread apart. */
export const REVIEWER_LABEL: Record<ReviewerKind, string> = {
  qa: "QA Agent",
  code_review: "Code Reviewer",
};

/** The org-settings flag that gates each reviewer. */
export const REVIEWER_FLAG: Record<
  ReviewerKind,
  "qa_agent_enabled" | "code_reviewer_enabled"
> = {
  qa: "qa_agent_enabled",
  code_review: "code_reviewer_enabled",
};

/** True when a thread title belongs to the given reviewer's run. */
export function isReviewerThreadTitle(
  title: string | null | undefined,
  kind: ReviewerKind,
): boolean {
  return title?.startsWith(`${REVIEWER_LABEL[kind]}:`) ?? false;
}

/** One activity entry, minimally shaped for the review-cycle reducers below.
 *  Both the server storage rows and the web `TASK_BOARD_ACTIVITY_LIST` output
 *  satisfy this, so the single source of truth for "which reviewer approved in
 *  the current cycle" is shared across api + web. */
export type ReviewCycleActivity = {
  action: string;
  data?: Record<string, unknown> | null;
  occurredAt: string;
};

/** When the task most recently entered In Review (ms since epoch), else 0 — the
 *  start of the current review cycle. Verdicts before this are stale. */
export function reviewCycleStart(activity: ReviewCycleActivity[]): number {
  let latest = 0;
  for (const a of activity) {
    if (a.action !== "status_changed") continue;
    if ((a.data as { to?: unknown } | null | undefined)?.to !== "in_review") {
      continue;
    }
    latest = Math.max(latest, new Date(a.occurredAt).getTime());
  }
  return latest;
}

/** Each reviewer's latest verdict within the current review cycle. Approvals /
 *  change-requests recorded before the cycle start are ignored. With
 *  `verifiedOnly`, an approval counts only when it was token-verified
 *  (`data.verified === true`) — the auto-merge gate uses this so a self-asserted
 *  (unverifiable) approval can't ship; the manual ship button does not. */
export function reviewCycleVerdicts(
  activity: ReviewCycleActivity[],
  opts?: { verifiedOnly?: boolean },
): Map<ReviewerKind, "approved" | "changes_requested"> {
  const start = reviewCycleStart(activity);
  const latest = new Map<ReviewerKind, "approved" | "changes_requested">();
  for (const a of activity) {
    if (
      a.action !== "review_approved" &&
      a.action !== "review_changes_requested"
    ) {
      continue;
    }
    if (new Date(a.occurredAt).getTime() < start) continue;
    const d = (a.data ?? {}) as { reviewer?: unknown; verified?: unknown };
    if (d.reviewer !== "qa" && d.reviewer !== "code_review") continue;
    if (a.action === "review_approved") {
      if (opts?.verifiedOnly && d.verified !== true) continue;
      latest.set(d.reviewer, "approved");
    } else {
      latest.set(d.reviewer, "changes_requested");
    }
  }
  return latest;
}

/** True when every enabled reviewer's latest cycle verdict is an approval. Empty
 *  `enabled` → false (nothing has signed off yet); callers that treat "no
 *  reviewers" as ready handle that themselves. */
export function allReviewersApproved(
  activity: ReviewCycleActivity[],
  enabled: ReviewerKind[],
  opts?: { verifiedOnly?: boolean },
): boolean {
  if (enabled.length === 0) return false;
  const verdicts = reviewCycleVerdicts(activity, opts);
  return enabled.every((k) => verdicts.get(k) === "approved");
}

/**
 * Org-scoped SSE event pushed on `sseHub` whenever a Super Agent run advances a
 * task board item's status (enqueued→todo, executing→in_progress, PR→in_review).
 * Its `data` is the full updated `TaskBoardItem`; the web board patches its
 * react-query cache from it, so the board is real-time with no polling.
 */
export const TASK_BOARD_ITEM_UPDATED_EVENT = "task-board.item.updated";

/**
 * Org-scoped SSE event pushed on `sseHub` whenever a task board item is deleted.
 * Its `data` is `{ id }`; the web board drops that item from its react-query
 * cache, so a delete on one client clears the card on every open board.
 */
export const TASK_BOARD_ITEM_DELETED_EVENT = "task-board.item.deleted";
