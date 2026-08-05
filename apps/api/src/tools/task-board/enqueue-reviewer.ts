import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { StudioContextFactory } from "@/automations/fire";
import {
  isReviewerThreadTitle,
  REVIEWER_FLAG,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  reviewCycleStart,
  SUPER_AGENT_ASSIGNEE_ID,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import { resolveTaskRepoChoice } from "./claude-code-task-run";

/**
 * A Super Agent run finished — if it left a task In Review with an open PR,
 * enqueue the enabled reviewers. This is the HEADLESS trigger: it fires from the
 * projector's run-terminal hook (server-side), so reviewers start even with no
 * browser open, right when the Super Agent is done (not while it's still
 * pushing). Only a Super Agent thread finishing triggers it — a reviewer's own
 * run, also linked to the task, must not re-trigger. Best-effort; a failure
 * never disturbs the projector. Builds its own context (the hook has only
 * storage) as the task's owner.
 */
export async function enqueueReviewersOnThreadFinish(args: {
  contextFactory: StudioContextFactory;
  taskBoard: TaskBoardStorage;
  threadId: string;
  orgId: string;
}): Promise<void> {
  const { contextFactory, taskBoard, threadId, orgId } = args;
  try {
    for (const taskId of await taskBoard.linkedTaskIds(threadId, orgId)) {
      const item = await taskBoard.getById(taskId, orgId);
      if (
        !item ||
        item.status !== "in_review" ||
        item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID
      ) {
        continue;
      }
      // Only the Super Agent's own run triggers reviewers — its threads are
      // titled "Super Agent: …"; a reviewer's finishing run (also linked) is not.
      const finishing = item.threads.find((thr) => thr.threadId === threadId);
      if (!finishing?.title?.startsWith("Super Agent:")) continue;
      // Nothing to review without a PR (research/answer tasks reach In Review
      // too). Logged, not silent: this is a terminal park — no reviewer will
      // ever claim the card and nothing else moves it, so "why is this task
      // stuck In Review?" has to be answerable from the logs. The task prompt
      // steers no-code-change tasks to Done for exactly this reason.
      const prs = await taskBoard.listPrs(taskId, orgId);
      if (prs.length === 0) {
        console.warn(
          `[task-board] ${taskId} reached In Review with no PR — no reviewer ` +
            `enqueued; the card stays In Review until a human moves it`,
        );
        continue;
      }
      const ctx = await contextFactory(
        orgId,
        item.assignedBy ?? item.createdBy,
      );
      if (!ctx) continue;
      await enqueueEnabledReviewers(ctx, item);
    }
  } catch (err) {
    console.error("[task-board] reviewer trigger on run finish failed", err);
  }
}

/** Thread statuses past which a reviewer run is done — a live run has a
 *  non-terminal status. Mirrors the storage-layer set. */
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

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
    "describes (use the PR's preview / dev server when available), check the " +
    "acceptance criteria implied by the title and description, and look for " +
    "regressions in the affected flow. Judge outcomes, not the diff.",
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
export async function enqueueEnabledReviewers(
  ctx: StudioContext,
  task: TaskBoardItem,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(
    task.organizationId,
  );
  const flags = settings?.flags ?? {};
  const enabled = REVIEWER_KINDS.filter(
    (k) => flags[REVIEWER_FLAG[k]] === true,
  );
  if (enabled.length === 0) return;

  // A reviewer belongs to the current cycle if its thread is still live, or was
  // created since the task last entered In Review — either way don't re-enqueue.
  // A stale thread from a PRIOR cycle (before a Super Agent re-run bounced the
  // task back and forward) does NOT count, so reviewers re-run on re-review.
  const lastInReviewAt = await lastInReviewTime(ctx, task);
  const cycleAt = new Date(lastInReviewAt);

  // Each reviewer's claim + enqueue is independent (a separate DB row keyed by
  // its own kind), so run them CONCURRENTLY — this is on TASK_BOARD_ITEM_PRS_GET's
  // synchronous poll path, and serial awaits doubled its latency once both QA
  // and Code Reviewer are enabled.
  await Promise.all(
    enabled.map(async (kind) => {
      if (reviewerHandledThisCycle(task, kind, lastInReviewAt)) return;
      // Atomically claim the reviewer's slot for this cycle. The claim dedups
      // the two triggers (projector run-finish + the modal poll) that can fire
      // at the same instant — the loser's `claimed` is false, so it skips
      // instead of spawning a duplicate run. The claim's token binds the
      // reviewer's later decision back to this dispatch.
      let claimed: boolean;
      let token: string;
      try {
        ({ claimed, token } = await ctx.storage.taskBoard.claimReviewer(
          task.id,
          kind,
          cycleAt,
        ));
      } catch (err) {
        console.error(`[task-board] ${kind} reviewer claim failed`, err);
        return;
      }
      if (!claimed) return;
      await enqueueReviewerForTask(ctx, task, kind, token).catch(
        async (err) => {
          console.error(`[task-board] ${kind} reviewer enqueue failed`, err);
          // Nothing was dispatched — release the slot so the next poll/trigger
          // can retry this reviewer instead of finding it permanently claimed.
          await ctx.storage.taskBoard
            .releaseReviewerClaim(task.id, kind, cycleAt)
            .catch((releaseErr) =>
              console.error(
                `[task-board] ${kind} reviewer claim release failed`,
                releaseErr,
              ),
            );
        },
      );
    }),
  );
}

/** True when a reviewer of `kind` already has a live or this-cycle thread — the
 *  guard that stops a duplicate reviewer run on every poll / re-trigger.
 *  Exported for the unit test. */
export function reviewerHandledThisCycle(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
): boolean {
  return task.threads.some((thr) => {
    if (!isReviewerThreadTitle(thr.title, kind)) return false;
    const live =
      thr.status !== null && !TERMINAL_THREAD_STATUSES.has(thr.status);
    if (live) return true;
    return new Date(thr.createdAt).getTime() >= lastInReviewAt;
  });
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
 * Enqueue a single reviewer run: a fresh thread (titled `<Reviewer>: <task>`),
 * a "delegated to <reviewer>" timeline entry, and the review prompt dispatched
 * on the org's agent. The reviewer ends by calling `TASK_BOARD_REVIEW_DECISION`.
 */
async function enqueueReviewerForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  kind: ReviewerKind,
  reviewToken: string,
): Promise<void> {
  const organizationId = task.organizationId;

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
      ? `- The repository ${repo.owner}/${repo.name} is already cloned at your working directory and \`git\` and \`gh\` are authenticated — check the PR's branch out there to inspect / exercise the change.`
      : sandboxed
        ? `- Your working directory is EMPTY. Call \`mcp__studio__TASK_ADD_REPO\` with the connectionId of the PR's repository FIRST; it clones the repository and waits for the checkout, and \`git\` and \`gh\` are authenticated once it returns.`
        : "- Load the PR's repository to inspect / exercise the change.",
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
  await enqueueAgentRunForTask(ctx, task, {
    title: `${REVIEWER_LABEL[kind]}: ${task.title}`,
    prompt,
    temperature: 0.3,
    ...(sandboxed
      ? {
          harnessId: "claude-code" as const,
          agent: {
            instructions,
            disallowedTools: REVIEWER_DISALLOWED_TOOLS[kind],
          },
        }
      : {}),
    ...(repo ? { repo } : {}),
  });

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
