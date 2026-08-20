import { orgFlagEnabled } from "./organization/schema";

/**
 * Sentinel `assigneeId` for the org's Super Agent (the well-known Decopilot
 * agent). Not a real member userId — `validate-assignee` skips membership for
 * it, and assigning it enqueues a Super Agent run on the task. Lives in
 * `@decocms/shared` so both the server tools and the web board can import it.
 */
export const SUPER_AGENT_ASSIGNEE_ID = "super-agent";

/** Suggested colors a new tag cycles through, so consecutive tags are visually
 *  distinct without anyone having to choose. Any hex is valid — the picker's
 *  `<input type="color">` isn't limited to these, and neither is the reports
 *  import (which needs the palette server-side, hence its home here). */
const TAG_COLORS = [
  "#9ca3af",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

export const DEFAULT_TAG_COLOR = TAG_COLORS[0]!;

/** Suggested color for the `existingCount`-th tag created in an org. */
export function nextTagColor(existingCount: number): string {
  return TAG_COLORS[existingCount % TAG_COLORS.length] ?? DEFAULT_TAG_COLOR;
}

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

/**
 * What every sandbox-hosted run has to know about its checkout: it is
 * `--depth 1`.
 *
 * Without being told, agents reach for `git diff main...HEAD` — the three-dot
 * form needs a merge base, and a depth-1 clone has no common ancestor to find.
 * `fatal: main...HEAD: no merge base` hit **229 production runs**. Every one
 * recovered, and that is the cost: each spent model turns rediscovering the
 * same fact. Deepening the clone instead would put the fix on the boot path,
 * which is already the slowest part of a run.
 */
export const SHALLOW_CHECKOUT_NOTE =
  "Your checkout is SHALLOW (`git clone --depth 1`), so it has no merge base " +
  "and `git diff main...HEAD` (three dots) fails with " +
  '"fatal: main...HEAD: no merge base". To see a branch diff, either use the ' +
  "two-dot form against the fetched remote ref (`git fetch origin " +
  "<base> && git diff origin/<base> HEAD`), or deepen first with " +
  "`git fetch --deepen=100`. Same for `git log main..HEAD` and anything else " +
  "that needs shared history.";

/**
 * How a reviewer should read the change it is reviewing.
 *
 * Left to itself a reviewer improvises: fetch the PR ref, find the merge base,
 * `--stat`, then `git diff` sliced by directory because it cannot tell how big
 * the diff is. One production Code Reviewer run spent six turns and 46KB doing
 * that, across three overlapping slices of ONE diff — and a tool result is not
 * paid for once, it rides in the prompt of every turn after it.
 *
 * `gh pr diff` is served by the API, so it needs neither a fetch nor a merge
 * base and is immune to the shallow checkout that causes the improvising.
 */
export const PR_DIFF_RECIPE =
  "Read the diff with `gh pr diff <number>`. It comes from the API, so it " +
  "needs no fetch, no merge base, and is unaffected by the shallow checkout. " +
  "Read it ONCE — `gh pr diff <number> --name-only` first if you need to size " +
  "it, then pull the hunks you need per FILE. Do NOT re-run the diff sliced " +
  "by directory: each slice re-reads bytes you already have into every " +
  "remaining turn's context, and it is the largest avoidable cost in a review.";

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

/** The reviewer kinds this org has enabled, per its settings flags. Single
 *  home for a filter repeated at every call site that reads the review gate
 *  (enqueue, auto-merge, conflict resolution, manual ship). Both reviewers are
 *  default-on via `orgFlagEnabled` — only an explicit `false` drops one. */
export function enabledReviewerKinds(
  flags: Record<string, unknown> | null | undefined,
): ReviewerKind[] {
  return REVIEWER_KINDS.filter((k) => orgFlagEnabled(flags, REVIEWER_FLAG[k]));
}

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
 * True when every enabled reviewer approved, but the approvals do NOT satisfy
 * the verified gate the auto-merge requires.
 *
 * The card then shows a full set of green approvals and can never merge: the
 * reviewer whose token didn't verify has already spent its claim for the cycle,
 * so nothing re-dispatches it and no later event can change the verdict. It is
 * a dead end that looks like progress, which is why it gets its own predicate
 * rather than living as an `!allReviewersApproved(…, verifiedOnly)` fall-through.
 */
export function approvedButUnverified(
  activity: ReviewCycleActivity[],
  enabled: ReviewerKind[],
): boolean {
  return (
    allReviewersApproved(activity, enabled) &&
    !allReviewersApproved(activity, enabled, { verifiedOnly: true })
  );
}

/**
 * The notes of the task's most recent review verdict, when that verdict asked
 * for changes — i.e. the work still outstanding on its pull request.
 *
 * This is what makes a re-run a CONTINUATION rather than a restart. A reviewer
 * bounce already carries its own notes into the re-run prompt; a human pressing
 * Re-run (or re-assigning the card to the Super Agent) carried nothing, so the
 * agent re-derived the whole task from the title and re-litigated an approach
 * the reviewer had explicitly told it to keep. Two prod cards spent five rounds
 * that way, one with a reviewer writing "a correção em si está CERTA — não
 * refaça o approach" into a run that then redid it.
 *
 * Latest verdict wins, across cycles (a re-run's whole point is that the card
 * left In Review). An approval as the latest verdict returns null: there is
 * nothing outstanding to continue, so the re-run starts clean, exactly as
 * today. Pure, so the ordering rule is unit-tested.
 *
 * Ties go to the later element: `occurred_at` comes back through a JS `Date`,
 * so two verdicts recorded in the same millisecond compare equal and only the
 * activity list's own (append) order says which came second.
 */
export function outstandingReviewFeedback(
  activity: ReviewCycleActivity[],
): string | null {
  let latest: { at: number; notes: string | null } | null = null;
  for (const a of activity) {
    if (
      a.action !== "review_approved" &&
      a.action !== "review_changes_requested"
    ) {
      continue;
    }
    const at = new Date(a.occurredAt).getTime();
    if (latest && at < latest.at) continue;
    const notes = (a.data as { notes?: unknown } | null | undefined)?.notes;
    latest = {
      at,
      notes:
        a.action === "review_changes_requested" && typeof notes === "string"
          ? notes
          : null,
    };
  }
  return latest?.notes ?? null;
}

/**
 * How many times a task may be bounced back to the Super Agent by a reviewer
 * before the loop is broken and a human takes over.
 *
 * The reviewer → fix → re-review cycle has no natural fixed point: a reviewer
 * that keeps finding something will keep finding something, and each round
 * costs a sandbox run and (before the PR-branch pin) an extra pull request. One
 * live board logged 179 change-requests against 68 approvals, with a single
 * task rejected five times in an hour by the same reviewer on the same PR.
 *
 * Five is chosen to be clearly past "the reviewer had a point" and clearly
 * short of "we are burning runs on a disagreement a person should settle".
 */
export const MAX_REVIEW_BOUNCES = 5;

/**
 * When the task was most recently handed TO the Super Agent (ms since epoch),
 * else 0 — the start of its current delegation, and the point the bounce budget
 * counts from.
 *
 * `assignee_changed` with `to` = the Super Agent is only ever written by
 * `TASK_BOARD_ITEM_UPDATE`, i.e. a person assigning the card (or the intake
 * auto-assign). The automatic hand-off writes `to: null`, so it can't reset
 * anything — a runaway loop still terminates.
 */
export function delegationStart(activity: ReviewCycleActivity[]): number {
  let latest = 0;
  for (const a of activity) {
    if (a.action !== "assignee_changed") continue;
    if (
      (a.data as { to?: unknown } | null | undefined)?.to !==
      SUPER_AGENT_ASSIGNEE_ID
    ) {
      continue;
    }
    latest = Math.max(latest, new Date(a.occurredAt).getTime());
  }
  return latest;
}

/**
 * True when this task has already been handed back to the Super Agent
 * `MAX_REVIEW_BOUNCES` times, counting the change-request about to be recorded.
 *
 * Counts across all review CYCLES since the current delegation, not the current
 * cycle: the runaway loop IS the cycles — each bounce starts a fresh one, so a
 * per-cycle count is always 1 and would never trip.
 *
 * But it resets when a person hands the card back (see {@link delegationStart}).
 * Counting a card's whole lifetime made re-running a burnt-out task pointless:
 * four cards carrying 5-7 old bounces were re-delegated, and the very first
 * change-request tripped `6 + 1 >= 5` and handed each straight back — one review
 * round, zero retries. A person re-assigning the card is them saying "try
 * again"; this is what makes that mean something.
 */
export function reviewBounceLimitReached(
  activity: ReviewCycleActivity[],
  limit: number = MAX_REVIEW_BOUNCES,
): boolean {
  const since = delegationStart(activity);
  // Count review CYCLES that ended in a change-request, not change-request
  // rows. A reviewer can land more than one verdict against a single dispatch
  // — the claim fences the dispatch, not the decision — and only the first
  // moves the card, so counting rows charged a card twice for one bounce and
  // halved the real budget. Three of four cards in one org did exactly that.
  const bounced = new Set<number>();
  let cycle = 0;
  for (const a of [...activity].sort((x, y) =>
    x.occurredAt.localeCompare(y.occurredAt),
  )) {
    const at = new Date(a.occurredAt).getTime();
    if (a.action === "status_changed") {
      if ((a.data as { to?: unknown } | null | undefined)?.to === "in_review") {
        cycle = at;
      }
      continue;
    }
    if (a.action === "review_changes_requested" && at >= since) {
      bounced.add(cycle);
    }
  }
  return bounced.size + 1 >= limit;
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
