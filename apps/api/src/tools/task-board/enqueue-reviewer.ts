import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  enabledReviewerKinds,
  isReviewerThreadTitle,
  LANES,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  reviewCycleStart,
  reviewCycleVerdicts,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { handTaskToHuman } from "./run-reactions";
import { isThreadRunStale } from "@/tools/thread/helpers";
import { nudgeThreadTurn } from "./nudge-thread";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { enqueueAutomationFire } from "@/automations/dbos-sync";
import { REVIEWER_SYSTEM_KEY } from "@/automations/builtin";
import { reviewFenceKey } from "./reviewer-run";
import type { ClaudeCodeModelClass } from "@/harnesses/claude-code-env";

/** Thread statuses past which a reviewer run is done — a live run has a
 *  non-terminal status. Mirrors the storage-layer set. */
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

/**
 * True when a run thread is genuinely still running: non-terminal status AND a
 * heartbeat inside the stall window.
 *
 * Status alone is not liveness. A reviewer whose pod died mid-run stays
 * `in_progress` forever — the in-memory idle reaper is per-pod, and
 * `failNeverStartedThreads` only covers runs that never started
 * (`run_started_at IS NULL`), so a run that started and then went silent is
 * reaped by nobody. Uses the same heartbeat and window as the rest of the
 * codebase (`isThreadRunStale`), so "how long is too long" has one definition.
 */
function isThreadRunLive(
  thr: TaskBoardItem["threads"][number],
  now: number,
): boolean {
  if (thr.status === null || TERMINAL_THREAD_STATUSES.has(thr.status)) {
    return false;
  }
  return !isThreadRunStale(
    { updated_at: thr.lastActiveAt, last_progress_at: null },
    now,
  );
}

/**
 * True while the task's author — the Super Agent, i.e. any run thread that
 * isn't a reviewer's — is still going.
 *
 * Opening the PR moves the card to In Review *while the Super Agent is still
 * running*, so the card is reviewable long before the run that owns the
 * branch is finished. Title is the discriminator the rest
 * of the board already uses (`resolveThreadToolNames`); liveness is
 * {@link isThreadRunLive}, so a dead author's stall window releases the card
 * rather than stranding it.
 */
export function authorRunLive(task: TaskBoardItem, now: number): boolean {
  return task.threads.some(
    (thr) =>
      !REVIEWER_KINDS.some((kind) => isReviewerThreadTitle(thr.title, kind)) &&
      isThreadRunLive(thr, now),
  );
}

/**
 * Enqueue a review run for every reviewer the org enabled that hasn't already
 * run for the task's current review cycle. Called when a Super Agent task
 * reaches In Review with ready checks (from `prs-get`). Reviewers are NOT task
 * assignees — the task stays with the Super Agent; each reviewer runs as a
 * linked thread the board shows on the card, plus a "delegated to <reviewer>"
 * timeline entry. Best-effort per reviewer.
 */
/**
 * How long the reviewer waits for the PR's deploy preview to catch up with its
 * head commit before the card goes to a person.
 *
 * A deploy takes minutes, so this is mostly slack; what it really bounds is the
 * case that has no end (a build broken account-wide, a deploy misconfigured).
 * Without it, gating the reviewer would swap one silent strand for another: no verdict, no
 * hand-off, a card that reads as "in review" forever.
 */
const STALE_PREVIEW_HANDOFF_GRACE_MS = 30 * 60 * 1000;

/** True once a card has waited out {@link STALE_PREVIEW_HANDOFF_GRACE_MS} for a
 *  preview that still isn't its head commit's. Measured from the review cycle
 *  start, so it resets whenever the card comes back for a fresh review — the
 *  same stateless trick `noPrHandoffDue` uses. Pure — unit-tested. */
export function stalePreviewHandoffDue(
  cycleStartMs: number,
  nowMs: number,
): boolean {
  return nowMs - cycleStartMs >= STALE_PREVIEW_HANDOFF_GRACE_MS;
}

/**
 * True when a stale deploy preview should hand this card to a human.
 *
 * Only while the reviewer has NOT yet ruled on the current cycle. Once a
 * verdict is recorded, the preview already served its purpose — re-litigating
 * its staleness on every later sweep tick (auto-merge off, so the card sits In
 * Review after approval waiting on a human to ship) would strand an already
 * APPROVED card behind a "the Reviewer cannot verify this change" hand-off,
 * even though it already did. Pure — unit-tested.
 */
export function stalePreviewHandoffOwed(
  verdictRecorded: boolean,
  previewMatchesHead: boolean | undefined,
  lastInReviewAt: number,
  now: number,
): boolean {
  if (verdictRecorded || previewMatchesHead !== false) return false;
  return stalePreviewHandoffDue(lastInReviewAt, now);
}

export async function enqueueEnabledReviewers(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts?: {
    /** Whether the deploy preview shows the PR's head commit
     *  (`previewMatchesHead`). `false` holds the reviewer back — see the gate
     *  below.
     *  Omitted means "not checked", which dispatches as it always did. */
    previewMatchesHead?: boolean;
    /**
     * Reviewers to dispatch regardless of the org's `reviewer_enabled` flag —
     * the org setting is the only gate this replaces. `TASK_BOARD_RUN_REVIEWER`
     * passes it so a human can ask for the one review their org turned off;
     * every other gate below (a live author run, the attempt cap, a reviewer
     * already on this cycle) still applies, which is what stops the button
     * dispatching a second reviewer onto a card that has one.
     */
    kinds?: ReviewerKind[];
  },
): Promise<ReviewerKind[]> {
  const settings = await ctx.storage.organizationSettings.get(
    task.organizationId,
  );
  const enabled = opts?.kinds ?? enabledReviewerKinds(settings?.flags);
  if (enabled.length === 0) return [];
  // Deferred, not dropped — both callers re-poll; above the hand-offs on purpose.
  if (authorRunLive(task, Date.now())) return [];
  const modelClass: ClaudeCodeModelClass = orgFlagEnabled(
    settings?.flags,
    "cheap_reviewer_model",
  )
    ? "reviewer"
    : "default";

  // A reviewer belongs to the current cycle if its thread is still live, or was
  // created since the cycle opened — either way don't re-enqueue.
  // A stale thread from a PRIOR cycle (before a Super Agent re-run bounced the
  // task back and forward) does NOT count, so reviewers re-run on re-review.
  // The timeline is read unconditionally (`reviewCycleStartedAt` alone would do
  // for the boundary): the verdicts and the verdict asks below only exist here.
  const activity = await ctx.storage.taskBoard.listActivity(
    task.id,
    task.organizationId,
  );
  const cycleStartedAt = task.reviewCycleStartedAt;
  const lastInReviewAt = reviewCycleStart(activity, cycleStartedAt);
  const cycleAt = new Date(lastInReviewAt);
  // Which reviewers actually ruled this cycle. A reviewer thread that completed
  // without one is a spent attempt, not a review — see `isSpentAttempt`.
  const decided = reviewCycleVerdicts(activity, { cycleStartedAt });

  // Reviewers this call really dispatched — every gate below is a silent skip,
  // and the manual button needs to tell the human which of the two happened.
  const dispatched: ReviewerKind[] = [];

  // One reviewer today, but the enqueue stays a fan-out over `enabled`: each
  // dispatch is independent (its own fence id), and this runs on
  // TASK_BOARD_ITEM_PRS_GET's synchronous poll path, where serial awaits showed
  // up as latency when there were two.
  await Promise.all(
    enabled.map(async (kind) => {
      const verdictRecorded = decided.has(kind);
      // Ask before spending: a run that ended undecided still has everything it
      // reviewed in its session, so one more turn on its own thread is both
      // cheaper and better-informed than a fresh reviewer.
      if (!verdictRecorded) {
        const asked = verdictNudgedThreads(activity, lastInReviewAt);
        const owed = undecidedReviewerThread(task, kind, lastInReviewAt, asked);
        if (owed) {
          await requestMissingVerdict(ctx, task, kind, owed).catch((err) =>
            console.error(`[task-board] ${kind} verdict nudge failed`, err),
          );
          return;
        }
        // Asked, not yet answered: the follow-up run lands on the reviewer's own
        // thread, so between the dispatch and its first heartbeat the thread
        // still reads `completed` and everything below would spend an attempt on
        // a reviewer that is about to speak.
        if (awaitingVerdictNudge(asked, Date.now())) return;
      }
      // A dead end, not a wait — see `reviewerAttemptsExhausted`.
      if (
        reviewerAttemptsExhausted(
          task,
          kind,
          lastInReviewAt,
          Date.now(),
          verdictRecorded,
        )
      ) {
        await handTaskToHuman(
          ctx,
          task,
          `${REVIEWER_LABEL[kind]} failed ${MAX_REVIEWER_ATTEMPTS} times on ` +
            `this review — it will not be retried`,
        );
        return;
      }
      // Would be a verdict on the wrong bytes — see `previewMatchesHead`.
      if (opts?.previewMatchesHead === false) {
        if (
          stalePreviewHandoffOwed(
            verdictRecorded,
            opts.previewMatchesHead,
            lastInReviewAt,
            Date.now(),
          )
        ) {
          await handTaskToHuman(
            ctx,
            task,
            "the pull request's deploy preview is not showing its latest " +
              "commit (its checks never went green), so the Reviewer cannot " +
              "verify this change against what the PR actually does",
          );
        }
        return;
      }
      if (
        reviewerHandledThisCycle(
          task,
          kind,
          lastInReviewAt,
          Date.now(),
          verdictRecorded,
        )
      ) {
        return;
      }
      // Getting here with a dead reviewer thread from THIS cycle means the last
      // attempt failed (see `reviewerHandledThisCycle`), so this dispatch is a
      // RETRY and needs a fence of its own — the previous attempt's thread id
      // is taken, and reusing it would collapse the retry onto the corpse.
      const attempt = spentAttemptsThisCycle(
        task,
        kind,
        lastInReviewAt,
        Date.now(),
        verdictRecorded,
      );
      const queued = await fireReviewer(ctx, task, {
        kind,
        cycleAt,
        attempt,
        modelClass,
      }).catch((err) => {
        console.error(`[task-board] ${kind} reviewer enqueue failed`, err);
        return false;
      });
      if (queued) dispatched.push(kind);
    }),
  );
  return dispatched;
}

/**
 * How many times a reviewer may be dispatched for one review cycle.
 *
 * Two, not more: a reviewer run costs a full agent run, and a reviewer that
 * fails twice on the same PR is telling us something a third run won't fix.
 */
export const MAX_REVIEWER_ATTEMPTS = 2;

/** How many SPENT reviewer attempts of `kind` this cycle already has — ones
 *  that failed, or that are stuck non-terminal with a cold heartbeat. It is the
 *  dispatch's attempt ordinal, and so part of its fence id: a retry must not
 *  derive the same thread id as the corpse it is replacing.
 *  Pure; exported for the unit test. */
export function spentAttemptsThisCycle(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  now: number = Date.now(),
  verdictRecorded = true,
): number {
  return task.threads.filter(
    (thr) =>
      isReviewerThreadTitle(thr.title, kind) &&
      isSpentAttempt(thr, now, verdictRecorded) &&
      new Date(thr.createdAt).getTime() >= lastInReviewAt,
  ).length;
}

/** A reviewer attempt that produced no verdict and never will: it failed, it
 *  ended in any other terminal state without recording one, or it is
 *  non-terminal with a heartbeat past the stall window.
 *
 *  `verdictRecorded` is whether this reviewer has a verdict on the CURRENT
 *  cycle's timeline. A run that reaches a decision records it and then
 *  completes, so a `completed` thread used to be taken as proof of a review —
 *  but a reviewer can also run out of turns, or stop while it waits on a
 *  background task, and complete having decided nothing. That card was then
 *  stranded In Review at `0/1` forever: nothing re-dispatched it (the thread
 *  read as handled) and nothing handed it over (the attempts read as unspent).
 *  Defaults true so callers without the timeline keep the old reading. */
function isSpentAttempt(
  thr: TaskBoardItem["threads"][number],
  now: number,
  verdictRecorded = true,
): boolean {
  if (thr.status === "failed") return true;
  if (thr.status !== null && TERMINAL_THREAD_STATUSES.has(thr.status)) {
    return !verdictRecorded;
  }
  return thr.status !== null && !isThreadRunLive(thr, now);
}

/** The reviewer's threads belonging to the current cycle: created since the
 *  cycle started, plus any still-live one (which owns the cycle wherever it
 *  started). Pure. */
function reviewerThreadsThisCycle(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  now: number = Date.now(),
): TaskBoardItem["threads"] {
  return task.threads.filter((thr) => {
    if (!isReviewerThreadTitle(thr.title, kind)) return false;
    return (
      isThreadRunLive(thr, now) ||
      new Date(thr.createdAt).getTime() >= lastInReviewAt
    );
  });
}

/**
 * True when this reviewer has spent every attempt of the cycle on a FAILED run.
 *
 * This is a dead end, not a wait: the budget is per (task, reviewer, cycle), so
 * nothing dispatches this reviewer again until the card leaves and re-enters In
 * Review — which only a reviewer verdict or a human can cause. The verdict is
 * therefore never coming and the all-approved gate can never close,
 * so the caller hands the card to a person instead of letting the sweeper visit
 * it forever. Two cards sat In Review for six days on exactly this: one
 * approval each, and a reviewer that had died twice.
 *
 * Pure — unit-tested.
 */
export function reviewerAttemptsExhausted(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  now: number = Date.now(),
  verdictRecorded = true,
): boolean {
  const thisCycle = reviewerThreadsThisCycle(task, kind, lastInReviewAt, now);
  return (
    thisCycle.length > 0 &&
    // A hung attempt counts as spent, not just a failed one — otherwise a
    // reviewer whose pod keeps dying is re-dispatched forever, which is the
    // opposite mistake to the deadlock this replaced.
    thisCycle.every((thr) => isSpentAttempt(thr, now, verdictRecorded)) &&
    thisCycle.length >= MAX_REVIEWER_ATTEMPTS
  );
}

/**
 * True when a reviewer of `kind` needs no further dispatch this cycle — the
 * guard that stops a duplicate reviewer run on every poll / re-trigger.
 * Exported for the unit test.
 *
 * A FAILED reviewer thread does not count as handled. It used to: any thread
 * created since the cycle started satisfied this, so when both reviewers died on
 * an infrastructure error (a database-connection timeout, in the burst that
 * prompted this) the card sat In Review with two dead reviewer threads and
 * nothing to re-dispatch them for the rest of the cycle, and the verdicts never
 * came. A failure is not a review.
 *
 * Bounded by `MAX_REVIEWER_ATTEMPTS` so a reviewer that cannot run doesn't loop:
 * once this cycle has that many failed attempts, the card is left alone for a
 * human, exactly as before.
 *
 * ponytail: retries ANY failed reviewer rather than only the infrastructure ones
 * (`isTransientRunFailure`), because this guard sees thread refs, not failure
 * kinds, and a reviewer that reaches a verdict records it and COMPLETES — a
 * failed reviewer is almost always infrastructure. Classify here too if a
 * self-inflicted reviewer failure ever shows up.
 */
export function reviewerHandledThisCycle(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  now: number = Date.now(),
  verdictRecorded = true,
): boolean {
  const thisCycle = reviewerThreadsThisCycle(task, kind, lastInReviewAt, now);
  if (thisCycle.length === 0) return false;
  // A live run owns the cycle; never dispatch alongside it. "Live" is the
  // heartbeat, not the status: a reviewer whose pod died mid-run keeps
  // `in_progress` forever, and taking that at face value deadlocked the card —
  // nothing re-dispatches, and the merge gate waits on a verdict that will
  // never come. One sat that way while its co-reviewer had approved in 68
  // seconds.
  if (thisCycle.some((thr) => isThreadRunLive(thr, now))) return true;
  const spent = thisCycle.filter((thr) =>
    isSpentAttempt(thr, now, verdictRecorded),
  );
  // Every attempt spent and the budget is gone — stop, a human owns it now.
  if (spent.length >= MAX_REVIEWER_ATTEMPTS) return true;
  // Anything that finished and left a verdict IS a review, so the cycle is
  // handled. A run that completed without one is spent, not handled.
  return spent.length !== thisCycle.length;
}

/**
 * The reviewer's completed thread that owes this cycle a verdict and has not
 * been asked for one yet, else null.
 *
 * A reviewer that runs out of turns, or stops while it waits on a background
 * task, completes having decided nothing — and until it is asked, nothing on
 * the card can tell that apart from a review. Only `completed` threads qualify:
 * a failed run has no session left to answer with, and a live one is still
 * working. Pure — unit-tested.
 */
export function undecidedReviewerThread(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  alreadyAsked: ReadonlyMap<string, number>,
  now: number = Date.now(),
): TaskBoardItem["threads"][number] | null {
  return (
    task.threads.find(
      (thr) =>
        isReviewerThreadTitle(thr.title, kind) &&
        thr.status === "completed" &&
        !isThreadRunLive(thr, now) &&
        new Date(thr.createdAt).getTime() >= lastInReviewAt &&
        !alreadyAsked.has(thr.threadId),
    ) ?? null
  );
}

/** The reviewer threads already asked for a verdict this cycle. The timeline is
 *  the marker, so the ask survives a pod restart and can only happen once per
 *  thread. Pure — unit-tested. */
export function verdictNudgedThreads(
  activity: readonly {
    action: string;
    data?: Record<string, unknown> | null;
    occurredAt: string;
  }[],
  lastInReviewAt: number,
): Map<string, number> {
  const asked = new Map<string, number>();
  for (const a of activity) {
    if (a.action !== "review_verdict_requested") continue;
    const at = new Date(a.occurredAt).getTime();
    if (at < lastInReviewAt) continue;
    const threadId = (a.data as { threadId?: unknown } | null | undefined)
      ?.threadId;
    if (typeof threadId === "string") asked.set(threadId, at);
  }
  return asked;
}

/** How long an unanswered ask holds the reviewer's attempts back. Long enough
 *  to cover the queue wait before the follow-up run's first heartbeat, short
 *  enough that a card whose follow-up never ran still moves within one sweep or
 *  two. */
const VERDICT_NUDGE_GRACE_MS = 10 * 60 * 1000;

/** True while an ask made this cycle is still young enough that its follow-up
 *  run may not have started. Pure — unit-tested. */
export function awaitingVerdictNudge(
  asked: ReadonlyMap<string, number>,
  now: number,
): boolean {
  for (const at of asked.values()) {
    if (now - at < VERDICT_NUDGE_GRACE_MS) return true;
  }
  return false;
}

/** What the reviewer is told when it ended without deciding. Deliberately
 *  narrow: it is not being asked to review again, only to state the verdict its
 *  own run already reached. */
function missingVerdictPrompt(kind: ReviewerKind): string {
  return [
    `Your ${REVIEWER_LABEL[kind]} run ended without recording a decision, so the task is stuck: nothing ships and nobody is told why. A review that reaches no verdict is not a review.`,
    "",
    "Do exactly ONE thing in this run and then stop:",
    "- Call `TASK_BOARD_REVIEW_DECISION` now, with the verdict your review already reached and notes that say what you checked.",
    "- Approve ONLY if you actually exercised the change and it holds. If you could not finish — a check never came back, a preview never rendered, you ran out of room — `request_changes` and say exactly what is unresolved. That hands the card to a person, which is the correct outcome for an unfinished review.",
    "- Do NOT re-run the review, do NOT change any code, and do NOT wait on any background task: whatever you know right now is the verdict.",
  ].join("\n");
}

/**
 * Ask a reviewer run that finished without a verdict for one, on its OWN
 * thread.
 *
 * The ask is recorded on the timeline BEFORE the dispatch, and both are keyed
 * to the thread: the record is what stops a second ask (and what lets
 * `isSpentAttempt` treat a still-undecided thread as spent afterwards), so a
 * dispatch that throws must not look un-asked forever — the run is retried by
 * the next reviewer attempt, not by asking again.
 */
async function requestMissingVerdict(
  ctx: StudioContext,
  task: TaskBoardItem,
  kind: ReviewerKind,
  owed: TaskBoardItem["threads"][number],
): Promise<void> {
  const thread = await ctx.storage.threads.get(owed.threadId);
  // Only a v2 thread can take a new turn — dispatch nulls the part emitter for
  // v1 (same gate as `ensureReviewerCommented`).
  if (!thread || thread.message_storage_version !== 2) return;

  await ctx.storage.taskBoard.recordActivity({
    taskBoardItemId: task.id,
    action: "review_verdict_requested",
    actorId: null,
    data: { reviewer: kind, threadId: owed.threadId },
  });
  console.warn(
    `[task-board] ${kind} reviewer on ${task.id} completed with no verdict — ` +
      `asking for one`,
  );
  await nudgeThreadTurn(ctx, task, thread, {
    messageId: `review-verdict-${owed.threadId}`,
    prompt: missingVerdictPrompt(kind),
    workflowID: `review-verdict:${owed.threadId}`,
    runClass: "reviewer",
  });
}

/** Fire the built-in Reviewer on `task`; the fire workflow starts the run
 *  (`automations/card-run.ts`). False when the org has no Reviewer yet. */
async function fireReviewer(
  ctx: StudioContext,
  task: TaskBoardItem,
  review: {
    kind: ReviewerKind;
    cycleAt: Date;
    attempt: number;
    modelClass: ClaudeCodeModelClass;
  },
): Promise<boolean> {
  const builtin = await ctx.storage.automations.findBuiltinTrigger(
    task.organizationId,
    REVIEWER_SYSTEM_KEY,
  );
  if (!builtin) {
    console.warn(
      `[task-board] org ${task.organizationId} has no built-in Reviewer yet; review of ${task.id} waits`,
    );
    return false;
  }
  const eventKey = reviewFenceKey(
    task.id,
    review.kind,
    review.cycleAt,
    review.attempt,
  );
  await enqueueAutomationFire(
    {
      automationId: builtin.automationId,
      organizationId: task.organizationId,
      triggerId: builtin.triggerId,
      target: {
        kind: "card",
        itemId: task.id,
        columnKey: LANES.review,
        eventKey,
        movedBy: null,
        review: {
          kind: review.kind,
          cycleAt: review.cycleAt.toISOString(),
          attempt: review.attempt,
          modelClass: review.modelClass,
        },
      },
    },
    // The sweep and the dialog's poll both ask, seconds apart, before the run
    // links its thread; one fire per minute per attempt is enough to retry a
    // dispatch that failed and dropped its fence.
    {
      idempotencyKey: `${eventKey}:${Math.floor(Date.now() / 60_000)}`,
    },
  );
  return true;
}
