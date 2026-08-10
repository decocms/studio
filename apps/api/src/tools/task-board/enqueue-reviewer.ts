import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  isReviewerThreadTitle,
  REVIEWER_FLAG,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  reviewCycleStart,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import { readSandboxQaTemplateName } from "@/sandbox/lifecycle";
import { resolveTaskRepoChoice } from "./claude-code-task-run";

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
      // Getting here with a dead reviewer thread from THIS cycle means the last
      // attempt failed (see `reviewerHandledThisCycle`). Its claim row is still
      // there, and the claim key is (task, reviewer, cycle) — so without
      // releasing it first, `claimReviewer` below would lose to the corpse and
      // the retry would be a no-op.
      if (hasFailedAttemptThisCycle(task, kind, lastInReviewAt)) {
        await ctx.storage.taskBoard
          .releaseReviewerClaim(task.id, kind, cycleAt)
          .catch((err) =>
            console.error(
              `[task-board] ${kind} stale claim release failed`,
              err,
            ),
          );
      }
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

/**
 * How many times a reviewer may be dispatched for one review cycle.
 *
 * Two, not more: a reviewer run costs a full agent run, and a reviewer that
 * fails twice on the same PR is telling us something a third run won't fix.
 */
export const MAX_REVIEWER_ATTEMPTS = 2;

/** Does this cycle already have a FAILED reviewer thread of `kind`? Decides
 *  whether the dispatch below is a retry (and so has a stale claim row to clear
 *  first). Pure; exported for the unit test. */
export function hasFailedAttemptThisCycle(
  task: TaskBoardItem,
  kind: ReviewerKind,
  lastInReviewAt: number,
): boolean {
  return task.threads.some(
    (thr) =>
      isReviewerThreadTitle(thr.title, kind) &&
      thr.status === "failed" &&
      new Date(thr.createdAt).getTime() >= lastInReviewAt,
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
 * nothing to re-dispatch them — the claim row stayed, `claimReviewer` refused
 * every retry for the rest of the cycle, and the verdicts never came. A failure
 * is not a review.
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
): boolean {
  const thisCycle = task.threads.filter((thr) => {
    if (!isReviewerThreadTitle(thr.title, kind)) return false;
    const live =
      thr.status !== null && !TERMINAL_THREAD_STATUSES.has(thr.status);
    return live || new Date(thr.createdAt).getTime() >= lastInReviewAt;
  });
  if (thisCycle.length === 0) return false;
  // A live run owns the cycle; never dispatch alongside it.
  if (
    thisCycle.some(
      (thr) => thr.status !== null && !TERMINAL_THREAD_STATUSES.has(thr.status),
    )
  ) {
    return true;
  }
  const failed = thisCycle.filter((thr) => thr.status === "failed");
  // Every attempt failed and the budget is gone — stop, a human owns it now.
  if (failed.length >= MAX_REVIEWER_ATTEMPTS) return true;
  // Anything that finished without failing IS a review (a reviewer records its
  // decision and completes), so the cycle is handled.
  return failed.length !== thisCycle.length;
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
      ? `- The repository ${repo.owner}/${repo.name} is already cloned at your working directory and \`git\` and \`gh\` are authenticated — check the PR's branch out there to inspect / exercise the change.`
      : sandboxed
        ? `- Your working directory is EMPTY. Call \`mcp__studio__TASK_ADD_REPO\` with the connectionId of the PR's repository FIRST; it clones the repository and waits for the checkout, and \`git\` and \`gh\` are authenticated once it returns.`
        : "- Load the PR's repository to inspect / exercise the change.",
    ...(kind === "qa"
      ? [
          `- Exercise the change on the PR's deploy \`previewUrl\` (from \`${prsGetTool}\`), deep-linked to the page/route the task affects (not root). If you cannot render or exercise it, do NOT approve — \`request_changes\` with what's blocking.`,
          sandboxed
            ? "- For a VISUAL change, capture before/after with `qa-screenshot <url> <outfile.png> [--mobile] [--full]` (headless Chromium, baked into the sandbox). Write the files under `org/output/` (e.g. `org/output/qa/before-desktop.png`, `after-mobile.png`) so they surface on the task; capture both desktop AND `--mobile` for responsive changes."
            : '- For a VISUAL change, capture before/after with the `take_screenshot` tool (`device: "desktop"` and `device: "mobile"` for responsive changes) and use `inspect_page` for console/runtime errors; the images attach to the thread automatically.',
          `- Record what you validated with \`${commentTool}\` (scenarios + pass/fail, a before→after screenshot pointer, the URL + viewport exercised, and anything you couldn't verify) BEFORE your decision.`,
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
  await enqueueAgentRunForTask(ctx, task, {
    // A verdict is the last thing between this card and Done — it outranks
    // starting a new task for the next slot.
    runClass: "reviewer",
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
          // QA runs need the browser-bearing QA sandbox image to screenshot the
          // preview. Only when a QA template is configured — else undefined, so
          // QA falls back to the default template (no browser) and just reports
          // it couldn't screenshot. Never applied to the Code Reviewer.
          ...(kind === "qa" && readSandboxQaTemplateName()
            ? { sandboxTemplateName: readSandboxQaTemplateName() }
            : {}),
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
