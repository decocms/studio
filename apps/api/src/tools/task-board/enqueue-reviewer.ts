import { createHash } from "node:crypto";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  enabledReviewerKinds,
  isReviewerThreadTitle,
  PR_DIFF_RECIPE,
  NO_VISUAL_SURFACE,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  reviewCycleStart,
  reviewCycleVerdicts,
  SHALLOW_CHECKOUT_NOTE,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated, handTaskToHuman } from "./run-reactions";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import {
  resolveTaskRepoChoice,
  type TaskRepoChoice,
} from "./claude-code-task-run";
import { isThreadRunStale } from "@/tools/thread/helpers";
import { mintReviewToken } from "./review-token";
import {
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";
import { nudgeThreadTurn } from "./nudge-thread";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
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
 * The Super Agent is told to link the PR and set In Review *while still
 * running* (`claude-code-task-run.ts`), so the card is reviewable long before
 * the run that owns the branch is finished. Title is the discriminator the rest
 * of the board already uses (`resolveTaskRunToolNames`); liveness is
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

/** The reviewer's instructions. Shared scaffolding (load the PR, end with a
 *  decision) lives in the prompt builder; this is the persona, and the ORDER in
 *  it is load-bearing — see `ReviewerKind`. No `disallowedTools`: the reviewer
 *  is the last run on the task, so it has to be able to fix what it finds. */
const REVIEWER_FOCUS: Record<ReviewerKind, string> = {
  // prompt-region:start reviewer
  reviewer:
    "You are the Reviewer, the LAST automated run on this task. Your job is to " +
    "confirm the task ACTUALLY SOLVED THE PROBLEM, fix what is wrong with how " +
    "it was solved, and then ship or hand over. Nothing picks up findings you " +
    "only describe, so an issue you write down and leave is an issue that " +
    "ships.\n" +
    "Do it in THIS ORDER — the order is the point:\n" +
    "1. REVIEW the code. FIRST look for a review skill/command appropriate to " +
    "this repository's stack (e.g. a `/review`, `code-review`, or " +
    "`security-review` skill, or the repo's CONTRIBUTING/review guidelines) " +
    "and use it. Read the diff critically for correctness, security and " +
    "quality, and note concrete issues with file/line references.\n" +
    "2. FIX what you found, on the PR's OWN branch, and push to that same pull " +
    "request — never a new branch, never a new pull request, never a force " +
    "push, and never any other ref. Keep the fixes scoped to what your review " +
    "found; do not redesign the change. Before you push, run the repository's " +
    "own checks (its type-check / lint / test / format scripts) and make them " +
    "pass — you are approving this code, so an unverified fix of yours is the " +
    "same defect as the one you were fixing. If a fix does not hold, revert it " +
    "and describe it instead of pushing it.\n" +
    "3. EXERCISE the change on the PR's deploy preview, AFTER your push, on the " +
    "preview of the commit you actually pushed — the earlier preview is a " +
    "different build and a verdict on it is a verdict on bytes that will not " +
    "ship. Wait for it if it is still building. Deep-link to the specific " +
    "page/route the task affects (not just its root), check the acceptance " +
    "criteria implied by the title and description, and look for regressions " +
    "in the affected flow. Judge OUTCOMES, not the diff — NEVER approve on " +
    "inspection alone. For any VISUAL change capture the affected view BEFORE " +
    "(the current production / base-branch site) and AFTER (the preview), and " +
    "for a responsive change capture BOTH a desktop and a real mobile view (a " +
    "phone viewport AND a mobile user-agent — not a narrowed desktop). The " +
    "How-to steps below name the exact screenshot tool for your run.\n" +
    "If the preview will not render (303s, hangs, blank) or you otherwise " +
    "cannot exercise the change, do NOT approve: request changes stating what " +
    "is blocking and what is needed to unblock. An unverified preview is not a " +
    "pass.\n" +
    "4. RECORD the whole pass as a task comment BEFORE the decision — a " +
    "durable record, separate from the short decision summary, and REQUIRED: a " +
    "verdict with no comment is an incomplete run and you will be asked for " +
    "one. Structure it: what you read and the concrete issues with file/line " +
    "references, WHICH of them you fixed (with the commits), the acceptance " +
    "criteria / scenarios you exercised with a pass/fail on each, a " +
    "before→after pointer to the screenshots, the exact URL(s) and viewport, " +
    "and anything you did not review or could not verify and why.\n" +
    "That comment must ALWAYS carry the visual change: embed the before/after " +
    "screenshots in it whenever the change has any visual surface. If it has " +
    `none, write the exact words \`${NO_VISUAL_SURFACE}\` in the comment and ` +
    "name why (backend-only, config, test-only) — that literal is what a " +
    "machine check looks for, so no paraphrase of it counts, and silence about " +
    "screenshots is not an acceptable answer either way.\n" +
    "5. DECIDE. Approve once the pull request is in the state you would " +
    "approve. Only `request_changes` for something you genuinely cannot settle " +
    "here (a product decision, a missing credential, an approach that needs " +
    "rethinking) — that hands the card to a human, it does not start another " +
    "agent round. NEVER end your run without having called " +
    "`TASK_BOARD_REVIEW_DECISION`: a run that stops to wait on a background " +
    "task, or that runs low on room, must decide on what it knows first. An " +
    "unrecorded verdict strands the card and is the one failure this run " +
    "cannot leave behind.",
  // prompt-region:end reviewer
};

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
  },
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(
    task.organizationId,
  );
  const enabled = enabledReviewerKinds(settings?.flags);
  if (enabled.length === 0) return;
  // Deferred, not dropped — both callers re-poll; above the hand-offs on purpose.
  if (authorRunLive(task, Date.now())) return;
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
      await enqueueReviewerForTask(
        ctx,
        task,
        kind,
        cycleAt,
        attempt,
        modelClass,
      ).catch((err) =>
        console.error(`[task-board] ${kind} reviewer enqueue failed`, err),
      );
    }),
  );
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

/**
 * The `TASK_ADD_REPO` id for the repository a card already names, when the org
 * has several and the run would otherwise have to go looking.
 *
 * Every reviewer in a multi-repo org opened by calling `TASK_ADD_REPO` with no
 * arguments — the discovery form, which answers with the org's whole catalog —
 * and only then called it again with the id. A card that names its repo makes
 * that round trip pure waste. Null when the card names no repo, when the sole
 * repo is already cloned (nothing to pick), or when the name matches nothing
 * loadable: each leaves the run to discover it as before.
 */
export function pinnedRepoId(
  taskRepo: string | null,
  choice: TaskRepoChoice,
): string | null {
  if (!taskRepo || !choice || !("choices" in choice)) return null;
  return choice.choices.find((c) => c.repo === taskRepo)?.id ?? null;
}

/**
 * When this reviewer last finished a run on an EARLIER review cycle, in ms —
 * else 0.
 *
 * A re-review is not a review: the Super Agent pushed more commits onto a PR
 * this reviewer already read end to end. Told nothing, the second run repeats
 * the first almost exactly (in production, $3.39 against $3.51 for a fraction
 * of the change). Given the moment it last ruled, it can ask git what moved.
 *
 * Only `completed` threads count. A `failed` (or otherwise dead, see
 * `isSpentAttempt`) prior attempt never read the PR end to end and posted no
 * verdict — telling the next run it's a "RE-REVIEW" of a diff slice since that
 * corpse's last heartbeat would have it skip reviewing code nobody actually
 * reviewed.
 */
export function priorCycleReviewAt(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
): number {
  const times = task.threads
    .filter(
      (thr) =>
        isReviewerThreadTitle(thr.title, kind) &&
        thr.status === "completed" &&
        new Date(thr.createdAt).getTime() < lastInReviewAt,
    )
    .map((thr) => new Date(thr.lastActiveAt).getTime())
    .filter((ms) => Number.isFinite(ms));
  return times.length === 0 ? 0 : Math.max(...times);
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

/**
 * The one string that identifies a reviewer dispatch: (task, reviewer, cycle,
 * attempt). Both fences below are derived from it, so they can only agree.
 * `toISOString()` must be the ONLY serialization of the cycle — a formatting
 * difference between the trigger paths silently breaks the fence.
 */
function reviewFenceKey(
  taskId: string,
  kind: ReviewerKind,
  cycleAt: Date,
  attempt: number,
): string {
  return `review:${taskId}:${kind}:${cycleAt.toISOString()}:${attempt}`;
}

/**
 * The reviewer run's thread id, derived from the fence key so the `threads` PK
 * IS the dispatch fence: the two triggers (60s sweeper, the task dialog's 10s
 * poll) can race and the loser's insert conflicts instead of spawning a second
 * reviewer run.
 */
function reviewerThreadId(fenceKey: string): string {
  const digest = createHash("sha256")
    .update(fenceKey)
    .digest("hex")
    .slice(0, 32);
  return `thrd_${digest}`;
}

/**
 * Enqueue a single reviewer run: a fresh thread (titled `<Reviewer>: <task>`),
 * a "delegated to <reviewer>" timeline entry, and the review prompt dispatched
 * on the org's agent. The reviewer ends by calling `TASK_BOARD_REVIEW_DECISION`.
 *
 * `attempt` is the cycle's spent-attempt count — it only moves the fence, so a
 * retry after a dead attempt gets ids of its own instead of colliding with the
 * corpse.
 */
async function enqueueReviewerForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  kind: ReviewerKind,
  cycleAt: Date,
  attempt: number,
  modelClass: ClaudeCodeModelClass,
): Promise<void> {
  const organizationId = task.organizationId;
  // Proves to TASK_BOARD_REVIEW_DECISION that the caller is this reviewer.
  const reviewToken = mintReviewToken(task.id, kind, cycleAt);

  // Same harness the Super Agent runs on, for the same reason: a review needs
  // real `git`/`gh` on a checkout, and — the blocking one — only a
  // sandbox-hosted run is handed the task-run MCP surface that carries
  // `TASK_BOARD_ITEM_PRS_GET` and `TASK_BOARD_REVIEW_DECISION`. On Decopilot
  // (the previous default) both came back `not_found` from `enable_tool`, so a
  // reviewer could reach its verdict and never record it. Falls back to
  // Decopilot when the org has no importable repo, exactly as the Super Agent
  // does — with no repo there is no checkout to review anyway.
  const choice = await resolveTaskRepoChoice(ctx, organizationId);
  const repo = choice && "repo" in choice ? choice.repo : null;
  const sandboxed = choice !== null;
  const priorReviewAt = priorCycleReviewAt(task, kind, cycleAt.getTime());
  const pinnedRepo = pinnedRepoId(task.repo, choice);
  // Over the sandbox's MCP client the task-run tools are namespaced; hosted
  // Decopilot calls them bare. Naming them wrong is not cosmetic — it is what
  // the model retries `enable_tool` against before giving up.
  const prsGetTool = sandboxed
    ? "mcp__studio__TASK_BOARD_ITEM_PRS_GET"
    : "TASK_BOARD_ITEM_PRS_GET";
  const decisionTool = sandboxed
    ? "mcp__studio__TASK_BOARD_REVIEW_DECISION"
    : "TASK_BOARD_REVIEW_DECISION";
  const commentTool = sandboxed
    ? "mcp__studio__TASK_BOARD_COMMENT_CREATE"
    : "TASK_BOARD_COMMENT_CREATE";
  const commentListTool = sandboxed
    ? "mcp__studio__TASK_BOARD_COMMENT_LIST"
    : "TASK_BOARD_COMMENT_LIST";

  // Who this run IS. On the sandboxed path this becomes the harness's system
  // instructions (`agent.instructions`), replacing the org agent's own — those
  // describe the Super Agent that wrote the PR, which is the last persona a
  // reviewer of that PR should inherit. The Decopilot fallback has no such hook,
  // so there it is prepended to the prompt instead (same text, one home).
  const instructions = [
    REVIEWER_FOCUS[kind],
    "",
    "You are running AUTONOMOUSLY — no human is watching this run. Making the " +
      "approve / request-changes call IS your job; you are the decision-maker, " +
      "not an assistant asking a human to decide. NEVER use `user_ask` to ask " +
      'whether to approve, or to confirm an obvious call ("Approve the PR?"). ' +
      "Reserve `user_ask` for a genuine, unresolvable blocker only a human can " +
      "clear (e.g. a missing credential, or a requirement so ambiguous you " +
      "truly cannot judge the outcome) — that should be rare. When in doubt " +
      "between asking and deciding, DECIDE.",
    "",
    "Do NOT merge the pull request — the board does that itself once your " +
      "approval is in. Pushing fixes to the PR's own branch is expected of " +
      "you; opening a second pull request, force-pushing, or touching any " +
      "other ref is not.",
  ].join("\n");

  // Sandboxed only — `uploadsAsSandboxPaths` points at an org-fs mount the hosted harness lacks.
  const reviewerDescription =
    task.description && sandboxed
      ? uploadsAsSandboxPaths(task.description)
      : task.description;
  const reviewerUploadHint =
    task.description && reviewerDescription
      ? sandboxUploadHint(task.description, reviewerDescription)
      : null;

  const prompt = [
    ...(sandboxed ? [] : [instructions, ""]),
    `Task title: ${task.title}`,
    reviewerDescription ? `\nTask description:\n${reviewerDescription}\n` : "",
    ...(reviewerUploadHint ? [reviewerUploadHint, ""] : []),
    "How to work:",
    `- Call \`${prsGetTool}\` with the task id below to find the pull request under review.`,
    repo
      ? `- The repository ${repo.owner}/${repo.name} is already cloned at your working directory and \`git\` and its CLI (\`gh\` for GitHub, \`glab\` for GitLab) are authenticated — check the PR's branch out there to inspect / exercise the change. ${SHALLOW_CHECKOUT_NOTE}`
      : sandboxed
        ? `- Your working directory is EMPTY. Call \`mcp__studio__TASK_ADD_REPO\` ${
            pinnedRepo
              ? `with id \`${pinnedRepo}\` (${task.repo}) FIRST — do NOT call it with no arguments, that only lists the org's repositories and costs you a turn.`
              : `with the id of the PR's repository FIRST;`
          } it clones the repository and waits for the checkout, and \`git\` and its CLI are authenticated once it returns. ${SHALLOW_CHECKOUT_NOTE}`
        : "- Load the PR's repository to inspect / exercise the change.",
    `- ${PR_DIFF_RECIPE}`,
    ...(priorReviewAt > 0
      ? [
          `- This is a RE-REVIEW. You already reviewed an earlier version of this pull request and asked for changes, and there are more commits since (a human re-delegated the card, or your own fixes from that round are in the history). Read your own previous notes with \`${commentListTool}\`, then review WHAT MOVED SINCE — \`gh pr diff <number>\` still shows the whole PR, so narrow it with \`git log --since='${new Date(priorReviewAt).toISOString()}' --oneline\` and diff only those commits. Confirm your earlier notes were addressed and check the new commits for their own problems. Do NOT re-read the parts of the PR you already cleared.`,
        ]
      : []),
    `- Fix the issues you find on the PR's branch, run the repository's own checks, and push to that same PR. You are the last automated run on this task — nothing picks up findings you only describe.`,
    `- THEN exercise the change on the PR's deploy \`previewUrl\` (from \`${prsGetTool}\`) — re-read it after your push so you get the preview of YOUR commit, and wait for it if it is still building. Deep-link to the page/route the task affects (not root). If you cannot render or exercise it, do NOT approve — \`request_changes\` with what's blocking.`,
    // One path now: the browser lives in the sandbox image, and BOTH harnesses
    // have a sandbox to run it in — the hosted one gets its own once the repo
    // is loaded, which this prompt already tells it to do. Unlike a hosted
    // capture service, a local browser can also reach the run's OWN dev server
    // on localhost.
    '- For a VISUAL change, capture before/after by running `qa-screenshot <url> org/output/qa/<name>.png [--mobile] [--full] [--selector=<css>] [--console]` (headless Chromium, baked into the sandbox; also works against a dev server you started on localhost — none is running by default, this pod is a checkout). Choose the framing: default is the top viewport, `--full` is the whole page, and `--selector=\'<css>\'` frames just the component you changed (best for a focused before/after). Add `--mobile` too for a responsive change, and `--console` to catch the runtime errors a screenshot alone reports as a pass. WRITE them under `org/output/` — that\'s what surfaces them on the task. Then `Read` the files to actually LOOK at them: a screenshot you never opened is not verification. To INTERACT with a page — click, hit-test with `document.elementFromPoint`, fill a form — `qa-screenshot` is not enough, but the browser it drives is yours: write a throwaway node script that requires the global playwright-core: `const { chromium } = require("/usr/local/lib/node_modules/playwright-core"); chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] })`. Do NOT report a check as impossible because Playwright is missing — it is installed.',
    `- Record what you validated with \`${commentTool}\` (scenarios + pass/fail, the exact URL + viewport, and anything you couldn't verify) BEFORE your decision. EMBED the before/after shots inline as markdown images referencing their org/output path, and put each before/after PAIR in a two-column table so they render side by side, e.g.:\n\n| Before | After |\n| --- | --- |\n| ![before desktop](org/output/qa/before-desktop.png) | ![after desktop](org/output/qa/after-desktop.png) |\n\nStudio renders those as real images in the comment.`,
    `- End the run by calling \`${decisionTool}\` exactly once with the task id, ` +
      `reviewer "${kind}", the reviewToken below, and your decision:`,
    "  - `approve` when it's good to ship. Include a short summary of what you verified.",
    "  - `request_changes` ONLY for something you cannot settle here — it hands the task to a human, it does not start another agent round. Include specific, actionable notes.",
    "- The reviewToken proves you are this reviewer — pass it through EXACTLY as given. Without it your approval won't count toward an automatic merge.",
    `- \`${decisionTool}\` is how the verdict is recorded. A review that ends without it is thrown away and the task stays stuck In Review, so call it even when your notes are short.`,
    "",
    `(task id: ${task.id})`,
    `(reviewToken: ${reviewToken})`,
  ].join("\n");

  // Create + link the reviewer thread and dispatch its run (shared plumbing).
  const fenceKey = reviewFenceKey(task.id, kind, cycleAt, attempt);
  const fenceThreadId = reviewerThreadId(fenceKey);
  const { isNew } = await enqueueAgentRunForTask(ctx, task, {
    // A verdict is the last thing between this card and Done — it outranks
    // starting a new task for the next slot.
    runClass: "reviewer",
    title: `${REVIEWER_LABEL[kind]}: ${task.title}`,
    prompt,
    temperature: 0.3,
    ...(sandboxed
      ? {
          harnessId: "claude-code" as const,
          modelClass,
          agent: { instructions },
        }
      : {}),
    ...(repo ? { repo } : {}),
    fence: { threadId: fenceThreadId, workflowID: fenceKey },
  }).catch(async (err) => {
    // Nothing was dispatched, but the fence thread may already exist — and
    // `reviewerHandledThisCycle` would then read it as this cycle's reviewer
    // forever. Drop it so the next trigger retries.
    await ctx.storage.threads
      .delete(fenceThreadId)
      .catch((delErr) =>
        console.error(
          `[task-board] ${kind} fence thread cleanup failed`,
          delErr,
        ),
      );
    throw err;
  });
  // A concurrent trigger got there first — it owns this reviewer's dispatch.
  if (!isNew) return;

  // Timeline: "Super Agent delegated to <reviewer>" (machine actor → null), and
  // broadcast the now-linked thread so the card shows the reviewer session live
  // (reviewer runs never advance the card's status, so no status-advance emit
  // carries the fresh link — do it explicitly).
  await recordTaskActivity(ctx, {
    taskBoardItemId: task.id,
    action: "review_requested",
    actorId: null,
    data: { reviewer: kind },
  });
  const linked = await ctx.storage.taskBoard.getById(task.id, organizationId);
  if (linked) emitTaskBoardUpdated(organizationId, linked);
}
