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
 * The org's automated reviewer. A derived identity over the org's agent runtime
 * (never seeded), enabled per-org via the `reviewer_enabled` flag. When a Super
 * Agent task reaches In Review with passing/absent checks, one reviewer run is
 * enqueued — it is not a task assignee (the task stays with the Super Agent), it
 * runs as a linked review thread shown on the card.
 *
 * ONE reviewer, not two. QA and code review were separate runs on the same diff,
 * which bought a second opinion and paid for it twice: they raced (the Code
 * Reviewer pushed fixes while QA exercised a preview of the commit before them),
 * and a QA approval could ship code QA never saw. What earns the second look is
 * fresh CONTEXT — an implementer reads its own diff as it meant it, not as it is
 * — and one run after the implementer has that. Code review is a part of the
 * job, not a job.
 *
 * Review is SINGLE-PASS: the reviewer runs at most once per delegation, in a
 * fixed order — review, fix what it found on the PR's own branch, push, then
 * exercise the change on the preview of THAT push, then decide. A
 * `request_changes` verdict hands the card to a human instead of bouncing it
 * back to the Super Agent: the reviewer → fix → re-review loop had no natural
 * fixed point (one live board logged 179 change-requests against 68 approvals,
 * one task rejected five times in an hour on the same PR), and a reviewer that
 * applies its own findings removes the reason to loop at all.
 *
 * The union stays a union so every caller keeps reading a SET of reviewers —
 * adding a second one back is a one-line change here, not a refactor.
 */
export type ReviewerKind = "reviewer";

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
 * the diff is. One production review run spent six turns and 46KB doing
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

/**
 * The type a card takes when nobody picked one.
 *
 * `chore` because it asserts the least: calling unclassified work maintenance
 * overstates nothing, where `feature` or `bug` would claim something about it.
 * Shared so the column default, the create tool and the dialog can't drift.
 */
export const DEFAULT_TASK_TYPE = "chore";

export const REVIEWER_KINDS: ReviewerKind[] = ["reviewer"];

/** Human label for a reviewer — also the prefix of its run thread's title
 *  (`"Reviewer: <task>"`), which is how the board tells the thread apart. */
export const REVIEWER_LABEL: Record<ReviewerKind, string> = {
  reviewer: "Reviewer",
};

/**
 * Thread-title prefixes the two-reviewer era used.
 *
 * ponytail: a compat list, not a migration. A reviewer run dispatched before
 * this deploy is still going after it, and its title is how the board
 * recognises it — both for "don't dispatch a second one this cycle" and for
 * serving it `TASK_BOARD_REVIEW_DECISION` at all (`resolveReviewRunToolNames`).
 * Unrecognised, it loses the tool mid-run and its card sits In Review forever.
 * Delete once no in-flight cycle predates the deploy (a day is ample).
 */
const LEGACY_REVIEWER_LABELS = ["QA Agent", "Code Reviewer"];

/** What the reviewer writes verbatim when a change has no visual surface at
 *  all — the one alternative to embedding before/after screenshots in its task
 *  comment. A sentinel rather than a phrasing heuristic: "no visual
 *  regressions" is what a UI run that FORGOT its screenshots writes, and
 *  anything loose enough to accept a real justification accepts that too. */
export const NO_VISUAL_SURFACE = "NO VISUAL SURFACE";

/**
 * True when this org runs the automated Reviewer. Default-on via
 * `orgFlagEnabled` — only an explicit `false` turns it off.
 *
 * Carries over the two-reviewer opt-out: an org that had explicitly turned BOTH
 * the QA Agent and the Code Reviewer off wanted no automated review, and this
 * must not silently re-enable one. Turning either back on (or setting
 * `reviewer_enabled` at all) leaves the legacy keys behind for good.
 */
export function reviewerEnabled(
  flags: Record<string, unknown> | null | undefined,
): boolean {
  if (
    flags?.reviewer_enabled === undefined &&
    flags?.qa_agent_enabled === false &&
    flags?.code_reviewer_enabled === false
  ) {
    return false;
  }
  return orgFlagEnabled(flags, "reviewer_enabled");
}

/** The reviewer kinds this org has enabled. Single home for a filter repeated
 *  at every call site that reads the review gate (enqueue, auto-merge, conflict
 *  resolution, manual ship) — a list, so those call sites stay written against
 *  a set of reviewers. */
export function enabledReviewerKinds(
  flags: Record<string, unknown> | null | undefined,
): ReviewerKind[] {
  return reviewerEnabled(flags) ? REVIEWER_KINDS : [];
}

/**
 * The lanes a release process needs AFTER the pull request merges, sitting
 * between In Review and Done. A subset of both sides' status unions, so each
 * assigns these names with no cast. The lane TYPE is unconditional — every
 * status stays in the union, keeping `LANE_RANK`/`STATUS_CONFIG` exhaustive.
 * The flag gates REACHABILITY: which lanes a board offers, where a ship lands.
 */
export type DeliveryLane = "approved" | "merged" | "post_deploy_validation";

export const DELIVERY_LANES: DeliveryLane[] = [
  "approved",
  "merged",
  "post_deploy_validation",
];

/** True when this org runs the delivery lanes. Off by default. */
export function deliveryLanesEnabled(
  flags: Record<string, unknown> | null | undefined,
): boolean {
  return orgFlagEnabled(flags, "delivery_lanes_enabled");
}

/**
 * The lane a merged/shipped pull request moves its task to. Every automatic
 * ship path reads this, so "flag off means no behaviour change" is one tested
 * function rather than five call sites agreeing by luck. Falsy flags of every
 * shape resolve to `done`; that default IS the safety property.
 */
export function shippedLane(
  flags: Record<string, unknown> | null | undefined,
): "merged" | "done" {
  return deliveryLanesEnabled(flags) ? "merged" : "done";
}

/** True when a thread title belongs to the given reviewer's run — including the
 *  two-reviewer era's titles, see {@link LEGACY_REVIEWER_LABELS}. */
export function isReviewerThreadTitle(
  title: string | null | undefined,
  kind: ReviewerKind,
): boolean {
  if (!title) return false;
  return [REVIEWER_LABEL[kind], ...LEGACY_REVIEWER_LABELS].some((label) =>
    title.startsWith(`${label}:`),
  );
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

/**
 * When the task's current review cycle opened (ms since epoch), else 0 —
 * verdicts recorded before it are stale.
 *
 * The card's `reviewCycleStartedAt` IS the boundary: it is stamped when the
 * work becomes reviewable and re-stamped on every re-review, independently of
 * what lane the card sits in. That independence is the point — the cycle used
 * to be derived from the newest `status_changed → in_review`, which made the
 * lane load-bearing (a card could not leave In Review mid-review without
 * invalidating its own reviewer's verdict), and so pinned every card to In
 * Review while an agent was still working on it.
 *
 * The activity scan survives only as the fallback for a card stamped before
 * migration 189. Pass `null` for a card that has no column value and the old
 * derivation applies, so an in-flight cycle is never lost mid-deploy.
 */
export function reviewCycleStart(
  activity: ReviewCycleActivity[],
  cycleStartedAt: string | Date | null | undefined,
): number {
  if (cycleStartedAt) return new Date(cycleStartedAt).getTime();
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

/**
 * What every cycle-scoped reducer below needs: the card's own
 * `reviewCycleStartedAt` (see {@link reviewCycleStart}). It is a REQUIRED
 * field, not an optional one — a caller that forgets it would silently fall
 * back to the activity scan, which for a card written after migration 189 finds
 * no boundary at all and so counts a previous cycle's verdicts as current.
 */
export type ReviewCycleOpts = {
  cycleStartedAt: string | Date | null | undefined;
  /** Count an approval only when it was token-verified (`data.verified`). */
  verifiedOnly?: boolean;
};

/** Each reviewer's latest verdict within the current review cycle. Approvals /
 *  change-requests recorded before the cycle start are ignored. With
 *  `verifiedOnly`, an approval counts only when it was token-verified
 *  (`data.verified === true`) — the auto-merge gate uses this so a self-asserted
 *  (unverifiable) approval can't ship; the manual ship button does not. */
export function reviewCycleVerdicts(
  activity: ReviewCycleActivity[],
  opts: ReviewCycleOpts,
): Map<ReviewerKind, "approved" | "changes_requested"> {
  const start = reviewCycleStart(activity, opts.cycleStartedAt);
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
    // Verdicts recorded by the two-reviewer era are ignored on purpose: a `qa`
    // approval says nothing about whether the merged Reviewer has run, and
    // counting one would close the merge gate on half a review. A card mid-cycle
    // at deploy time gets a Reviewer dispatched and reaches a fresh verdict.
    if (d.reviewer !== "reviewer") continue;
    if (a.action === "review_approved") {
      if (opts?.verifiedOnly && d.verified !== true) continue;
      latest.set("reviewer", "approved");
    } else {
      latest.set("reviewer", "changes_requested");
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
  opts: ReviewCycleOpts,
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
  opts: ReviewCycleOpts,
): boolean {
  return (
    allReviewersApproved(activity, enabled, opts) &&
    !allReviewersApproved(activity, enabled, { ...opts, verifiedOnly: true })
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
