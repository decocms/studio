import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  outstandingReviewFeedback,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import {
  claimTaskExecution,
  rollbackTaskExecution,
  TaskQuotaError,
  userInitiatedTaskQuotaConfig,
} from "../../billing/task-quota";
import { isReportsTask } from "@decocms/shared/task-board";
import { captureOrgEvent } from "@/posthog";
import { getSettings } from "@/settings";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import type { RunClass } from "@/dispatch-queue/run-priority";
import { fetchPrHeadRef } from "./prs-get";
import { readPrStateThrottled } from "./dbos-github-read";
import {
  buildClaudeCodeTaskPrompt,
  resolveTaskRepoChoice,
} from "./claude-code-task-run";

/**
 * The shared post-write reaction for a task delegated to the Super Agent:
 * enqueue the run. No-op for any other assignee, so callers that already know
 * the write delegated (create) and callers that gate on the transition
 * (update) share one body. The SSE broadcast is emitted by each write site
 * itself (every create/update broadcasts, not just delegations). Enqueue is
 * best-effort — the task is already persisted, so a dispatch failure (e.g. no
 * model configured) must never fail the write that delegated it.
 */
export async function reactToSuperAgentDelegation(
  ctx: StudioContext,
  item: TaskBoardItem,
  opts?: Pick<SuperAgentPromptOpts, "userInitiated">,
): Promise<void> {
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return;
  await enqueueSuperAgentForTask(ctx, item, opts).catch((err) => {
    // A paywall rejection is NOT best-effort: swallowing it would leave the
    // task delegated-but-never-running with only a log line. Callers decide
    // (the update tool surfaces it; the import route un-delegates).
    if (err instanceof TaskQuotaError) throw err;
    console.error("[task-board] Super Agent enqueue failed", err);
  });
}

/**
 * Enqueue a Super Agent run for a task delegated to it. Creates a fresh thread
 * seeded with the task in context, then dispatches the org's Super Agent (the
 * well-known Decopilot agent) on it via the durable thread-gate queue.
 *
 * ponytail: deliberately the simplest thing that runs the agent on the task —
 * a single text message, smart tier, no tool allowlist. Iterate on the prompt,
 * model, and metadata from here.
 */
/** Options that steer the Super Agent prompt for a re-run on an existing PR. */
export type SuperAgentPromptOpts = {
  /** A reviewer's change request — leads the re-run prompt. */
  feedback?: string;
  /** The PR already under review, so the re-run updates it in place instead
   *  of opening a second PR. */
  pr?: { number: number; url: string };
  /** This re-run exists to resolve a merge conflict on `pr` (not reviewer
   *  feedback): the lead instructs a checkout + base merge + push. Requires
   *  `pr` — without it the conflict lead is skipped (a conflict instruction
   *  is meaningless with no PR to check out). */
  resolveConflict?: boolean;
  /** Admission class for the dispatched run — `"retry"` for a re-dispatch of
   *  work that already failed, so it outranks a brand-new task for the next
   *  slot. Defaults to a new task. See `dispatch-queue/run-priority.ts`. */
  runClass?: RunClass;
  /** A human asked for this run (`TASK_BOARD_ITEM_RERUN`), so the per-task run
   *  cap — which bounds automatic re-dispatch — does not apply to it. */
  userInitiated?: boolean;
};

/**
 * The autonomous Super Agent prompt for a task. Pure (no I/O) so the branch
 * selection is unit-tested: a fresh attempt, a reviewer's change request, or a
 * merge-conflict resolution — the last two lead with an instruction to update
 * the EXISTING PR rather than open a second one. Conflict resolution wins over
 * feedback when both are set.
 */
export function buildSuperAgentTaskPrompt(
  task: { id: string; title: string; description: string | null },
  opts?: SuperAgentPromptOpts,
): string {
  // Guidance tuned from observed runs. First: let the agent judge whether the
  // task even touches a repo — not every task does, and forcing a PR on a
  // research/answer task made it invent code changes. Only when it works on a
  // repo does the commit/push/PR flow apply. Then keep it direct: don't hunt for
  // the dev-server port, don't chase incidental symbols. Keep it tight — a
  // bloated prompt costs tokens every step.
  return [
    "You've been assigned this task. Complete it.",
    "",
    "You are running AUTONOMOUSLY — no human is watching this run, so drive it " +
      "to completion on your own. Use `user_ask` ONLY for a genuine, " +
      "unresolvable blocker a human must clear (a missing credential/secret, or " +
      "a decision so ambiguous you truly cannot proceed) — that should be rare. " +
      "Do not ask for confirmation of a reasonable choice; make it and move on.",
    "",
    `Title: ${task.title}`,
    task.description ? `\nDescription:\n${task.description}\n` : "",
    // A conflict re-run leads with the resolution instruction; a reviewer's
    // change request leads with its feedback. Either way the whole point is to
    // update the EXISTING PR, not re-do the task or open a second PR.
    opts?.resolveConflict && opts.pr
      ? [
          `Your pull request #${opts.pr.number} (${opts.pr.url}) is approved but can't be merged — it has a MERGE CONFLICT with its base branch.`,
          `Load the repo, CHECK OUT that PR's branch (e.g. \`gh pr checkout ${opts.pr.number}\`), then merge (or rebase) the base branch into it and resolve the conflicts, and push to update the SAME pull request — do NOT open a new one or start a new branch. Resolve conflicts by preserving BOTH sides' intent; never blindly discard either side. Change only what resolving the conflict requires.`,
          "",
        ].join("\n")
      : // When a reviewer bounced the task back, its feedback is the whole point
        // of this re-run — lead with it so the model addresses it (and updates
        // the EXISTING PR), not re-does the task from scratch or opens a second.
        opts?.feedback
        ? [
            opts.pr
              ? `A reviewer requested changes on the existing pull request #${opts.pr.number} (${opts.pr.url}):`
              : "A reviewer requested changes on your previous work:",
            opts.feedback,
            opts.pr
              ? `Load the repo, then CHECK OUT that PR's branch (e.g. \`gh pr checkout ${opts.pr.number}\`) before editing, address the feedback, commit, and push to update the SAME pull request — do NOT open a new one or start a new branch.`
              : "Address this feedback.",
            "",
          ].join("\n")
        : // A person re-delegated a task that already has an open PR. No
          // feedback to lead with, but the sandbox booted on that PR's branch,
          // so the default "commit on a new branch and open a pull request"
          // below would contradict where the run actually is — and produce the
          // second PR this pin exists to prevent.
          opts?.pr
          ? [
              `This task already has an open pull request #${opts.pr.number} (${opts.pr.url}), and you are already on its branch.`,
              `Continue that work: commit and push to update the SAME pull request — do NOT open a new one or start a new branch. If you find it already does everything the task asks, say so and stop rather than changing it.`,
              "",
            ].join("\n")
          : "",
    "How to work:",
    "- First decide whether this task requires changing code in a repository. Some tasks (research, answering a question, planning) don't. If it doesn't, just do the work directly — don't load a repo or open a PR.",
    // A re-run's lead block above (reviewer feedback OR conflict resolution)
    // overrides this: only a FIRST attempt opens a new branch + PR; a re-run
    // checks out the existing PR's branch and pushes to it.
    opts?.pr
      ? "- If it DOES need code changes: use the `load_repo` tool to load the relevant repository, make the change, then commit and push to the pull request named above."
      : "- If it DOES need code changes: use the `load_repo` tool to load the relevant repository, then make the change, commit on a new branch, push, and open a pull request. Only then does a PR apply.",
    "- Prefer the GitHub tool to open the PR. If it errors or targets the wrong repo, fall back to `git push` + the GitHub REST API (the auth token is embedded in the `origin` URL).",
    "- If a dev server is running it hot-reloads your changes — don't restart it, hunt for its port, or run a full typecheck/build just to verify a small edit.",
    "- Change only what the task needs. Don't trace the definition of a pre-existing symbol that's incidental to your change — note it in one line and move on. Prefer one or two broad searches over many narrow retries.",
    "- Only if you hit a genuine blocker a human must clear (see above) may you call `user_ask` — otherwise keep going and finish the task.",
    "",
    `(task id: ${task.id})`,
  ].join("\n");
}

/**
 * The head branch of the task's linked PR `prNumber`, or null when we can't
 * confirm one. Null is the safe answer everywhere it appears: the caller then
 * dispatches exactly as it does today (a fresh derived branch), which is the
 * behavior this whole path is trying to improve on but is never WRONG — it just
 * costs another PR.
 */
async function resolveRerunBranch(
  ctx: StudioContext,
  task: TaskBoardItem,
  prNumber: number,
): Promise<string | null> {
  const prs = await ctx.storage.taskBoard
    .listPrs(task.id, task.organizationId)
    .catch(() => []);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) return null;
  return fetchPrHeadRef(ctx, task.organizationId, pr).catch(() => null);
}

/** The reviewer feedback still outstanding on `task`, or null. Best-effort: an
 *  unreadable activity log costs the prompt its lead, never the dispatch. */
async function outstandingFeedback(
  ctx: StudioContext,
  task: TaskBoardItem,
): Promise<string | null> {
  const activity = await ctx.storage.taskBoard
    .listActivity(task.id, task.organizationId)
    .catch(() => []);
  return outstandingReviewFeedback(activity);
}

/**
 * Whether a PR's live state is trustworthy enough to pin the branch to: it
 * isn't DEFINITIVELY closed. `null` (GitHub unreachable, the throttled queue
 * timed out) counts as usable for the same reason it does in
 * `pickActivePrIndex` — a read blip must not silently fall through to "no PR
 * found", which is exactly the default, forking behavior this whole path
 * exists to avoid. Pure; exported for the unit test.
 */
export function prStateIsPinnable(state: "open" | "closed" | null): boolean {
  return state !== "closed";
}

/**
 * The task's own open (or unreadable) pull request, for a dispatch nobody
 * named one for.
 *
 * Only a reviewer bounce passes `opts.pr`. A person re-delegating the card
 * (`TASK_BOARD_ITEM_UPDATE`, `TASK_BOARD_ITEM_RERUN`) passes nothing, so the
 * branch pin below never applied to the path people actually use — three cards
 * grew a third pull request that way in one afternoon, each one the reviewer
 * then rejected as obsolete against `main`.
 *
 * Never falls back to a definitively-closed PR, unlike `pickActivePr`:
 * resuming work on a merged or abandoned branch is worse than starting a
 * fresh one. Reads go through the same throttled queue.
 */
async function openPrForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
): Promise<{ number: number; url: string } | undefined> {
  const prs = await ctx.storage.taskBoard
    .listPrs(task.id, task.organizationId)
    .catch(() => []);
  for (const pr of prs) {
    const { state } = await readPrStateThrottled(task.organizationId, pr);
    if (prStateIsPinnable(state)) return { number: pr.number, url: pr.url };
  }
  return undefined;
}

export async function enqueueSuperAgentForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts?: SuperAgentPromptOpts,
): Promise<void> {
  // Quota claim at dispatch — the funnel every FRESH execution shares
  // (update flip, import auto-delegation, review/conflict re-runs). A stall
  // nudge re-prompts an existing thread directly (stall-recovery.ts) and
  // deliberately doesn't re-claim: that task was claimed at first dispatch.
  // Claimed
  // BEFORE the harness choice below so both harnesses are gated. Idempotent
  // per task, so re-runs of a claimed task pass free; an exhausted quota
  // throws [SUBSCRIPTION_REQUIRED] and nothing enqueues. The interactive
  // flip pre-checks in TASK_BOARD_ITEM_UPDATE so the user sees the paywall
  // BEFORE the write; here the claim is the enforcement.
  const claim = await claimTaskExecution(
    ctx,
    task,
    opts?.userInitiated ? userInitiatedTaskQuotaConfig() : undefined,
  );

  let harness: "claude-code" | "decopilot" = "decopilot";
  try {
    // A re-run told to update an existing PR must land on that PR's BRANCH.
    // Asking the model to `gh pr checkout` (which the prompt does, and has
    // done all along) cannot work on its own: the sandbox key is derived from
    // the THREAD, every re-run is a new thread, so the pod boots on a fresh
    // `sandbox/thread-<new-id>` branch and the daemon's HEAD-based shutdown
    // push publishes THAT — a second pull request for the same task. One task
    // reached four open PRs this way, all with the same title.
    //
    // Pinning the PR's head branch makes the sandbox boot on it, so the same
    // push updates the same PR. Best-effort: a null head ref (GitHub
    // unreachable, PR already closed/merged) falls back to today's behavior
    // rather than pinning a ref we can't confirm exists.
    //
    // Applies to a person re-delegating the card too, not just a reviewer
    // bounce: only the bounce names a PR, and the human path is the one that
    // kept forking (see `openPrForTask`).
    const reusesPrBranch = getSettings().taskBoardRerunReusesPrBranch;
    const pr =
      opts?.pr ?? (reusesPrBranch ? await openPrForTask(ctx, task) : undefined);
    const pinnedRef =
      reusesPrBranch && pr
        ? await resolveRerunBranch(ctx, task, pr.number)
        : null;
    // The prompt must name the same PR the sandbox booted on. Only widened when
    // the flag is on: naming a PR the run is NOT pinned to is the combination
    // that produced the duplicates.
    //
    // Same idea for the feedback: a dispatch that lands on an existing PR is a
    // CONTINUATION, so it should carry what the last reviewer asked for. Only
    // the reviewer bounce passed that; a human's Re-run / re-assign passed
    // nothing and the agent restarted from the title, re-deciding an approach
    // the reviewer had told it to keep. Scoped to `pr` — with no PR to continue
    // there is nothing outstanding, and a fresh attempt should stay fresh.
    // Skipped when the caller already has a lead: a reviewer bounce passes its
    // own notes, and a conflict re-run's lead outranks feedback anyway.
    const wantsCarry = !opts?.feedback && !opts?.resolveConflict;
    const carried =
      pr && wantsCarry ? await outstandingFeedback(ctx, task) : null;
    const promptOpts: SuperAgentPromptOpts | undefined =
      (pr && pr !== opts?.pr) || carried
        ? {
            ...opts,
            ...(pr ? { pr } : {}),
            ...(carried ? { feedback: carried } : {}),
          }
        : opts;

    // Sandbox-hosted claude-code takes every task that has a repo it could work
    // in — bound before dispatch when there's exactly one, otherwise chosen
    // mid-run with `TASK_ADD_REPO` (see `claude-code-task-run.ts`). An org with
    // no repos imported runs Decopilot exactly as before.
    const choice = await resolveTaskRepoChoice(ctx, task.organizationId);

    if (choice) {
      harness = "claude-code";
      const repo = "repo" in choice ? choice.repo : null;
      await enqueueAgentRunForTask(ctx, task, {
        title: `Super Agent: ${task.title}`,
        ...(opts?.runClass ? { runClass: opts.runClass } : {}),
        ...(pinnedRef ? { pinnedRef } : {}),
        prompt: buildClaudeCodeTaskPrompt(task, repo, {
          ...promptOpts,
          // Names the candidates in the prompt so the run doesn't spend its first
          // step asking what exists.
          ...("choices" in choice ? { repoChoices: choice.choices } : {}),
        }),
        temperature: 0.5,
        harnessId: "claude-code",
        ...(repo ? { repo } : {}),
      });
    } else {
      await enqueueAgentRunForTask(ctx, task, {
        title: `Super Agent: ${task.title}`,
        ...(opts?.runClass ? { runClass: opts.runClass } : {}),
        prompt: buildSuperAgentTaskPrompt(task, promptOpts),
        temperature: 0.5,
        ...(pinnedRef ? { pinnedRef } : {}),
      });
    }
  } catch (err) {
    // Nothing was dispatched — no thread exists to ever trigger the
    // thread-finish refund pass (run-reactions.ts). Without this, a failure
    // here (e.g. no model configured — the exact case `enqueueAgentRunForTask`
    // can throw for) would leave the claim charged forever with no run to show
    // for it.
    //
    // ROLLBACK, not refund: no run happened, so the per-task tally must not be
    // spent either — otherwise a task whose dispatch keeps failing dies at the
    // run cap with a quota error for runs that never existed. That holds for a
    // `"rerun"` too: it incremented the same tally, and the sweeper's automatic
    // retries spend it, so a card whose re-dispatch keeps throwing used to walk
    // itself to the cap without ever starting a run. Its period SLOT is not
    // ours to give back (an earlier run really did ride it) — that distinction
    // lives in `rollbackTaskExecution`.
    await rollbackTaskExecution(
      ctx.storage.organizationBilling,
      task.organizationId,
      task.id,
      claim,
    );
    throw err;
  }

  // A fresh attempt owns the card, so the older failures are history, not state.
  await ctx.storage.taskBoard
    .supersedeFailedThreads(task.id, task.organizationId)
    .catch((err) =>
      console.error("[task-board] superseding failed threads failed", err),
    );

  // The dispatch really happened — the auto-fix leg of the PLG funnel.
  // OUTSIDE the try/catch above: telemetry must never couple into the
  // billing rollback (a throw here after a successful dispatch would refund
  // a run that exists). Whether this dispatch is a re-run is `claim ===
  // "rerun"` — no separate flag.
  captureOrgEvent({
    event: "task_run_enqueued",
    organizationId: task.organizationId,
    properties: {
      task_id: task.id,
      reports_task: isReportsTask(task),
      claim,
      harness,
      ...(opts?.runClass ? { run_class: opts.runClass } : {}),
    },
  });
}
