import { createHash } from "node:crypto";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  enabledReviewerKinds,
  isReviewerThreadTitle,
  REVIEWER_LABEL,
  reviewCycleStart,
  SHALLOW_CHECKOUT_NOTE,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated, handTaskToHuman } from "./run-reactions";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import { resolveTaskRepoChoice } from "./claude-code-task-run";
import { isThreadRunStale } from "@/tools/thread/helpers";
import { mintReviewToken } from "./review-token";
import {
  flagsForRepo,
  orgFlagEnabled,
} from "@decocms/shared/organization/schema";
import type { ClaudeCodeModelClass } from "@/harnesses/claude-code-env";

/** Thread statuses past which a reviewer run is done — a live run has a
 *  non-terminal status. Mirrors the storage-layer set. */
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

/**
 * True when a reviewer thread is genuinely still running: non-terminal status
 * AND a heartbeat inside the stall window.
 *
 * Status alone is not liveness. A reviewer whose pod died mid-run stays
 * `in_progress` forever — the in-memory idle reaper is per-pod, and
 * `failNeverStartedThreads` only covers runs that never started
 * (`run_started_at IS NULL`), so a run that started and then went silent is
 * reaped by nobody. Uses the same heartbeat and window as the rest of the
 * codebase (`isThreadRunStale`), so "how long is too long" has one definition.
 */
function isReviewerThreadLive(
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
 * Built-in harness tools each reviewer must NOT have — the enforcement behind
 * "you are reviewing, not implementing", which until now was prompt-only.
 *
 * Neither reviewer can rewrite an existing file. QA keeps `Write` because
 * exercising a change means scratch files (a curl script, a throwaway spec);
 * the Code Reviewer reads the diff and has no reason to touch the checkout at
 * all. Both keep `Bash` — a review is `git diff` / `gh pr view`, and QA has to
 * actually run the thing.
 *
 * These are SDK tool NAMES, which is all `disallowedTools` matches. "Don't
 * push" stays a prompt rule on purpose: a permission pattern like
 * `Bash(git push:*)` is not a tool name (it would be a silent no-op here), and
 * any command-level denylist is bypassable from a shell anyway.
 */
export const REVIEWER_DISALLOWED_TOOLS: Record<ReviewerKind, string[]> = {
  qa: ["Edit", "NotebookEdit"],
  code_review: ["Write", "Edit", "NotebookEdit"],
};

/** The review instructions unique to each reviewer. Shared scaffolding (load
 *  the PR, don't push code, end with a decision) lives in the prompt builder. */
const REVIEWER_FOCUS: Record<ReviewerKind, string> = {
  qa:
    "You are the QA Agent. Your job is to confirm the task ACTUALLY SOLVED THE " +
    "PROBLEM — not to review code style. Exercise the feature/behavior the task " +
    "describes, check the acceptance criteria implied by the title and " +
    "description, and look for regressions in the affected flow. Judge outcomes, " +
    "not the diff — and NEVER approve on inspection alone: an approval must be " +
    "backed by evidence you actually exercised the change.\n" +
    "Exercise the change on the PR's deploy preview, deep-linked to the specific " +
    "page/route the task affects (not just its root). For any VISUAL change, " +
    "capture the affected view BEFORE (the current production / base-branch site) " +
    "and AFTER (the preview) so the two can be compared, and for a responsive " +
    "change capture BOTH a desktop and a real mobile view (a phone viewport AND a " +
    "mobile user-agent — not a narrowed desktop). The How-to steps below name the " +
    "exact screenshot tool for your run.\n" +
    "If the preview will not render (303s, hangs, blank) or you otherwise cannot " +
    "exercise the change, do NOT approve: request changes stating what is blocking " +
    "and what is needed to unblock. An unverified preview is not a pass.\n" +
    "RECORD your QA pass as a task comment BEFORE the decision — a durable record, " +
    "separate from the short decision summary. Structure it: the acceptance " +
    "criteria / scenarios you checked with a pass/fail on each, a before→after " +
    "pointer to the screenshots, the exact URL(s) and viewport you exercised, and " +
    "anything you could not verify and why.",
  code_review:
    "You are the Code Reviewer. Review the code changes for correctness, " +
    "security, and quality. FIRST look for a review skill/command appropriate " +
    "to this repository's stack (e.g. a `/review`, `code-review`, or " +
    "`security-review` skill, or the repo's CONTRIBUTING/review guidelines) and " +
    "use it. Read the diff critically and flag concrete issues with file/line " +
    "references.",
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
 * How long QA waits for the PR's deploy preview to catch up with its head
 * commit before the card goes to a person.
 *
 * A deploy takes minutes, so this is mostly slack; what it really bounds is the
 * case that has no end (a build broken account-wide, a deploy misconfigured).
 * Without it, gating QA would swap one silent strand for another: no verdict, no
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

export async function enqueueEnabledReviewers(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts?: {
    /** Whether the deploy preview shows the PR's head commit
     *  (`previewMatchesHead`). `false` holds QA back — see the gate below.
     *  Omitted means "not checked", which dispatches as it always did. */
    previewMatchesHead?: boolean;
  },
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(
    task.organizationId,
  );
  const enabled = enabledReviewerKinds(flagsForRepo(settings, task.repo));
  if (enabled.length === 0) return;
  const modelClass: ClaudeCodeModelClass = orgFlagEnabled(
    settings?.flags,
    "cheap_reviewer_model",
  )
    ? "reviewer"
    : "default";

  // A reviewer belongs to the current cycle if its thread is still live, or was
  // created since the task last entered In Review — either way don't re-enqueue.
  // A stale thread from a PRIOR cycle (before a Super Agent re-run bounced the
  // task back and forward) does NOT count, so reviewers re-run on re-review.
  const lastInReviewAt = await lastInReviewTime(ctx, task);
  const cycleAt = new Date(lastInReviewAt);

  // Each reviewer's enqueue is independent (its own fence id), so run them
  // CONCURRENTLY — this is on TASK_BOARD_ITEM_PRS_GET's synchronous poll path,
  // and serial awaits doubled its latency once both QA and Code Reviewer are
  // enabled.
  await Promise.all(
    enabled.map(async (kind) => {
      // A dead end, not a wait — see `reviewerAttemptsExhausted`.
      if (reviewerAttemptsExhausted(task, kind, lastInReviewAt)) {
        await handTaskToHuman(
          ctx,
          task,
          `${REVIEWER_LABEL[kind]} failed ${MAX_REVIEWER_ATTEMPTS} times on ` +
            `this review — it will not be retried`,
        );
        return;
      }
      // Would be a verdict on the wrong bytes — see `previewMatchesHead`.
      if (kind === "qa" && opts?.previewMatchesHead === false) {
        if (stalePreviewHandoffDue(lastInReviewAt, Date.now())) {
          await handTaskToHuman(
            ctx,
            task,
            "the pull request's deploy preview is not showing its latest " +
              "commit (its checks never went green), so QA cannot verify this " +
              "change against what the PR actually does",
          );
        }
        return;
      }
      if (reviewerHandledThisCycle(task, kind, lastInReviewAt)) return;
      // Getting here with a dead reviewer thread from THIS cycle means the last
      // attempt failed (see `reviewerHandledThisCycle`), so this dispatch is a
      // RETRY and needs a fence of its own — the previous attempt's thread id
      // is taken, and reusing it would collapse the retry onto the corpse.
      const attempt = spentAttemptsThisCycle(task, kind, lastInReviewAt);
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
): number {
  return task.threads.filter(
    (thr) =>
      isReviewerThreadTitle(thr.title, kind) &&
      isSpentAttempt(thr, now) &&
      new Date(thr.createdAt).getTime() >= lastInReviewAt,
  ).length;
}

/** A reviewer attempt that produced no verdict and never will: it failed, or it
 *  is non-terminal with a heartbeat past the stall window. */
function isSpentAttempt(
  thr: TaskBoardItem["threads"][number],
  now: number,
): boolean {
  if (thr.status === "failed") return true;
  return (
    thr.status !== null &&
    !TERMINAL_THREAD_STATUSES.has(thr.status) &&
    !isReviewerThreadLive(thr, now)
  );
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
      isReviewerThreadLive(thr, now) ||
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
 * approval each, and a QA Agent that had died twice.
 *
 * Pure — unit-tested.
 */
export function reviewerAttemptsExhausted(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
  now: number = Date.now(),
): boolean {
  const thisCycle = reviewerThreadsThisCycle(task, kind, lastInReviewAt, now);
  return (
    thisCycle.length > 0 &&
    // A hung attempt counts as spent, not just a failed one — otherwise a
    // reviewer whose pod keeps dying is re-dispatched forever, which is the
    // opposite mistake to the deadlock this replaced.
    thisCycle.every((thr) => isSpentAttempt(thr, now)) &&
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
): boolean {
  const thisCycle = reviewerThreadsThisCycle(task, kind, lastInReviewAt, now);
  if (thisCycle.length === 0) return false;
  // A live run owns the cycle; never dispatch alongside it. "Live" is the
  // heartbeat, not the status: a reviewer whose pod died mid-run keeps
  // `in_progress` forever, and taking that at face value deadlocked the card —
  // nothing re-dispatches, and the merge gate waits on a verdict that will
  // never come. One sat that way while its co-reviewer had approved in 68
  // seconds.
  if (thisCycle.some((thr) => isReviewerThreadLive(thr, now))) return true;
  const spent = thisCycle.filter((thr) => isSpentAttempt(thr, now));
  // Every attempt spent and the budget is gone — stop, a human owns it now.
  if (spent.length >= MAX_REVIEWER_ATTEMPTS) return true;
  // Anything that finished without failing IS a review (a reviewer records its
  // decision and completes), so the cycle is handled.
  return spent.length !== thisCycle.length;
}

/** When the task most recently entered In Review (ms), else 0. Drawn from the
 *  activity timeline (shared reducer) so it survives across the many-to-many
 *  thread links and stays in lockstep with the merge gate + ship button. */
async function lastInReviewTime(
  ctx: StudioContext,
  task: TaskBoardItem,
): Promise<number> {
  const activity = await ctx.storage.taskBoard.listActivity(
    task.id,
    task.organizationId,
  );
  return reviewCycleStart(activity);
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
    "Do NOT push commits, merge, or change the code to fix what you find. You " +
      "are reviewing, not implementing — the tools that would let you rewrite " +
      "the checkout are removed from this run on purpose. Report what you find " +
      "in your decision instead.",
  ].join("\n");

  const prompt = [
    ...(sandboxed ? [] : [instructions, ""]),
    `Task title: ${task.title}`,
    task.description ? `\nTask description:\n${task.description}\n` : "",
    "How to work:",
    `- Call \`${prsGetTool}\` with the task id below to find the pull request under review.`,
    repo
      ? `- The repository ${repo.owner}/${repo.name} is already cloned at your working directory and \`git\` and \`gh\` are authenticated — check the PR's branch out there to inspect / exercise the change. ${SHALLOW_CHECKOUT_NOTE}`
      : sandboxed
        ? `- Your working directory is EMPTY. Call \`mcp__studio__TASK_ADD_REPO\` with the connectionId of the PR's repository FIRST; it clones the repository and waits for the checkout, and \`git\` and \`gh\` are authenticated once it returns.`
        : "- Load the PR's repository to inspect / exercise the change.",
    ...(kind === "qa"
      ? [
          `- Exercise the change on the PR's deploy \`previewUrl\` (from \`${prsGetTool}\`), deep-linked to the page/route the task affects (not root). If you cannot render or exercise it, do NOT approve — \`request_changes\` with what's blocking.`,
          // Two paths because the harnesses differ: the sandbox has a real
          // browser baked in (`qa-screenshot`, which can also reach its own dev
          // server on localhost); hosted Decopilot has no sandbox and uses its
          // Browserless-backed built-in, which streams the image into the thread.
          sandboxed
            ? "- For a VISUAL change, capture before/after with `qa-screenshot <url> org/output/qa/<name>.png [--mobile] [--full] [--selector=<css>]` (headless Chromium, baked into the sandbox; also works against your own dev server on localhost). Choose the framing: default is the top viewport, `--full` is the whole page, and `--selector='<css>'` frames just the component you changed (best for a focused before/after). WRITE them under `org/output/` — that's what surfaces them on the task. Then `Read` the files to actually LOOK at them — a screenshot you never opened is not verification. Add `--mobile` too for a responsive change."
            : '- For a VISUAL change, capture before/after with the `take_screenshot` tool (`device: "desktop"` and `device: "mobile"` for responsive changes) and use `inspect_page` for console/runtime errors; the images attach to the thread automatically.',
          sandboxed
            ? `- Record what you validated with \`${commentTool}\` (scenarios + pass/fail, the exact URL + viewport, and anything you couldn't verify) BEFORE your decision. EMBED the before/after shots inline as markdown images referencing their org/output path, and put each before/after PAIR in a two-column table so they render side by side, e.g.:\n\n| Before | After |\n| --- | --- |\n| ![before desktop](org/output/qa/before-desktop.png) | ![after desktop](org/output/qa/after-desktop.png) |\n\nStudio renders those as real images in the comment.`
            : `- Record what you validated with \`${commentTool}\` (scenarios + pass/fail, a before→after pointer to the attached shots, the exact URL + viewport, and anything you couldn't verify) BEFORE your decision.`,
        ]
      : []),
    `- End the run by calling \`${decisionTool}\` exactly once with the task id, ` +
      `reviewer "${kind}", the reviewToken below, and your decision:`,
    "  - `approve` when it's good to ship. Include a short summary of what you verified.",
    "  - `request_changes` when something is wrong or missing. Include specific, actionable notes — the task goes back to the Super Agent with your notes.",
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
          agent: {
            instructions,
            disallowedTools: REVIEWER_DISALLOWED_TOOLS[kind],
          },
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
