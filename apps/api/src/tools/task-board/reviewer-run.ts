/**
 * One reviewer run on a card: its prompt, its fence, and the dispatch. Started
 * by the built-in Reviewer's fire (`automations/card-run.ts`); when to start
 * it, and when to stop trying, is the review sweep's call
 * (`enqueue-reviewer.ts`).
 */

import { createHash } from "node:crypto";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  isReviewerThreadTitle,
  LANES,
  NO_VISUAL_SURFACE,
  PR_DIFF_RECIPE,
  REVIEWER_LABEL,
  SHALLOW_CHECKOUT_NOTE,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import type { ClaudeCodeModelClass } from "@/harnesses/claude-code-env";
import { recordTaskActivity } from "./activity";
import {
  resolveTaskRepoChoice,
  type TaskRepoChoice,
} from "./claude-code-task-run";
import {
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import { mintReviewToken } from "./review-token";
import { emitTaskBoardUpdated } from "./run-reactions";

/** Who the reviewer is and what the board needs from it. How to review is the
 *  In Review lane's editable rule (`task-board-default-prompts.ts`). No
 *  `disallowedTools`: the reviewer is the last run on the task, so it has to be
 *  able to fix what it finds. */
const REVIEWER_FOCUS: Record<ReviewerKind, string> = {
  // prompt-region:start reviewer
  reviewer:
    "You are the Reviewer, the LAST automated run on this task: you judge the " +
    "pull request another run opened for it, and record the verdict. An " +
    "approval sends the task to QA, where a person checks it.\n" +
    "Before deciding, RECORD your pass as a task comment — REQUIRED: a " +
    "verdict with no comment is an incomplete run and you will be asked for " +
    "one. The record is internal: written for the agents on this task, so be " +
    "as technical as needed.\n" +
    'Then TELL THE PERSON who reviews the task, in one comment with `audience: "human"`. ' +
    "They do not read code: write in the language the task is written in, " +
    "with no file names, code or engineering jargon. Approving a visual " +
    "change: say it is approved and embed the before/after screenshots there " +
    "— screenshots only in the internal record reach no one, and the machine " +
    "check does not count them. Approving a change with no visual surface: " +
    `skip this comment, and write the exact words \`${NO_VISUAL_SURFACE}\` ` +
    "in the record and name why (backend-only, config, test-only) — that " +
    "literal is what a machine check looks for, so no paraphrase of it " +
    "counts. Requesting changes: this comment is REQUIRED — say what they " +
    "have to decide or do, and why, in terms of the product.\n" +
    "Then DECIDE. `request_changes` hands the card to a human; it does not " +
    "start another agent round. NEVER end your run without having called " +
    "`TASK_BOARD_REVIEW_DECISION`: a run that stops to wait on a background " +
    "task, or that runs low on room, must decide on what it knows first. An " +
    "unrecorded verdict strands the card and is the one failure this run " +
    "cannot leave behind.",
  // prompt-region:end reviewer
};

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

/**
 * The one string that identifies a reviewer dispatch: (task, reviewer, cycle,
 * attempt). Both fences below are derived from it, so they can only agree.
 * `toISOString()` must be the ONLY serialization of the cycle — a formatting
 * difference between the trigger paths silently breaks the fence.
 */
export function reviewFenceKey(
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
export function reviewerThreadId(fenceKey: string): string {
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
export async function enqueueReviewerForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  kind: ReviewerKind,
  cycleAt: Date,
  attempt: number,
  modelClass: ClaudeCodeModelClass,
  /** The built-in Reviewer's trigger, so the run shows in its history. */
  triggerId: string,
): Promise<boolean> {
  const organizationId = task.organizationId;
  // Proves to TASK_BOARD_REVIEW_DECISION that the caller is this reviewer.
  const reviewToken = mintReviewToken(task.id, kind, cycleAt);

  // Same harness the Super Agent runs on: a review needs real `git`/`gh` on a
  // checkout, and only a sandbox-hosted run is handed the thread MCP surface
  // that carries `TASK_BOARD_ITEM_PRS_GET` and `TASK_BOARD_REVIEW_DECISION`.
  const choice = await resolveTaskRepoChoice(ctx, organizationId, {
    repositoryId: task.repositoryId,
    repo: task.repo,
  });
  if (!choice) {
    throw new Error(
      "Reviewer runs need the hosted sandbox, which this deployment does not have.",
    );
  }
  const repo = "repo" in choice ? choice.repo : null;
  const priorReviewAt = priorCycleReviewAt(task, kind, cycleAt.getTime());
  const pinnedRepo = pinnedRepoId(task.repo, choice);

  // Who this run IS: replaces the org agent's instructions, which describe the
  // Super Agent that wrote the PR.
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
    "Do NOT merge the pull request — it merges once people have checked the " +
      "task in QA and cleared it for release. Pushing fixes to the PR's own branch is expected of " +
      "you; opening a second pull request, force-pushing, or touching any " +
      "other ref is not.",
  ].join("\n");

  // The user turn the thread shows: the task under review.
  const description = task.description
    ? uploadsAsSandboxPaths(task.description)
    : null;
  const prompt = [
    task.title,
    description,
    task.description && description
      ? sandboxUploadHint(task.description, description)
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const system = [
    "The user message is the task whose pull request you review.",
    "",
    "How to work:",
    "- Call `mcp__studio__TASK_BOARD_ITEM_PRS_GET` with the task id below to find the pull request under review.",
    repo
      ? `- The repository ${repo.owner}/${repo.name} is already cloned at your working directory and \`git\` and its CLI (\`gh\` for GitHub, \`glab\` for GitLab; Bitbucket has no CLI — use the REST API with \`curl\` and \`$BITBUCKET_TOKEN\`) are authenticated — check the PR's branch out there to inspect / exercise the change. ${SHALLOW_CHECKOUT_NOTE}`
      : `- Your working directory is EMPTY. Call \`mcp__studio__TASK_ADD_REPO\` ${
          pinnedRepo
            ? `with id \`${pinnedRepo}\` (${task.repo}) FIRST — do NOT call it with no arguments, that only lists the org's repositories and costs you a turn.`
            : `with the id of the PR's repository FIRST;`
        } it clones the repository and waits for the checkout, and \`git\` and its CLI are authenticated once it returns. ${SHALLOW_CHECKOUT_NOTE}`,
    `- ${PR_DIFF_RECIPE}`,
    ...(priorReviewAt > 0
      ? [
          `- This is a RE-REVIEW. You already reviewed an earlier version of this pull request and asked for changes, and there are more commits since (a human re-delegated the card, or your own fixes from that round are in the history). Read your own previous notes with \`mcp__studio__TASK_BOARD_COMMENT_LIST\`, then review WHAT MOVED SINCE — \`gh pr diff <number>\` still shows the whole PR, so narrow it with \`git log --since='${new Date(priorReviewAt).toISOString()}' --oneline\` and diff only those commits. Confirm your earlier notes were addressed and check the new commits for their own problems. Do NOT re-read the parts of the PR you already cleared.`,
        ]
      : []),
    "- Record what you validated with `mcp__studio__TASK_BOARD_COMMENT_CREATE` BEFORE your decision; a comment is internal by default.",
    '- Post the comment for the person reviewing the task with `audience: "human"`, with the before/after screenshots embedded inline as markdown images referencing their /app/org/output path.',
    "- End the run by calling `mcp__studio__TASK_BOARD_REVIEW_DECISION` exactly once with the task id, " +
      `reviewer "${kind}", the reviewToken below, and your decision:`,
    "  - `approve` when it's good to ship. Include a short summary of what you verified.",
    "  - NEVER approve on inspection alone: approve only a change you exercised at the PR's latest commit. If you could not exercise it at all, `request_changes` saying which paths you tried and what blocked them — whatever the board's rules say.",
    "  - `request_changes` ONLY for something you cannot settle here — it hands the task to a human, it does not start another agent round. Include specific, actionable notes, written for that person: if you posted no comment for them, these notes are shown to them as they are.",
    "- The reviewToken proves you are this reviewer — pass it through EXACTLY as given. Without it your approval won't move the task to QA.",
    "- `mcp__studio__TASK_BOARD_REVIEW_DECISION` is how the verdict is recorded. A review that ends without it is thrown away and the task stays stuck In Review, so call it even when your notes are short.",
    "",
    `(task id: ${task.id})`,
    `(reviewToken: ${reviewToken})`,
  ].join("\n");

  // Create + link the reviewer thread and dispatch its run (shared plumbing).
  const fenceKey = reviewFenceKey(task.id, kind, cycleAt, attempt);
  const fenceThreadId = reviewerThreadId(fenceKey);
  const { isNew } = await enqueueAgentRunForTask(ctx, task, {
    // A verdict is what hands this card to a person — it outranks starting a
    // new task for the next slot.
    runClass: "reviewer",
    triggerId,
    title: `${REVIEWER_LABEL[kind]}: ${task.title}`,
    rulesColumn: LANES.review,
    prompt,
    system,
    temperature: 0.3,
    modelClass,
    agent: { instructions },
    ...(repo ? { repo } : {}),
    fence: { threadId: fenceThreadId, workflowID: fenceKey },
    runRoot: `${REVIEWER_LABEL[kind]} started reviewing this card.`,
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
  if (!isNew) return false;

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
  return true;
}
