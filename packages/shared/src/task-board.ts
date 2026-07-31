/**
 * Sentinel `assigneeId` for the org's Super Agent (the well-known Decopilot
 * agent). Not a real member userId — `validate-assignee` skips membership for
 * it, and assigning it enqueues a Super Agent run on the task. Lives in
 * `@decocms/shared` so both the server tools and the web board can import it.
 */
export const SUPER_AGENT_ASSIGNEE_ID = "super-agent";

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
