import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { claimTaskExecution } from "../../billing/task-quota";
import { enqueueAgentRunForTask } from "./enqueue-task-run";
import {
  buildClaudeCodeTaskPrompt,
  claudeCodeEnabledForOrg,
  resolveSoleTaskRepo,
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
): Promise<void> {
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return;
  await enqueueSuperAgentForTask(ctx, item).catch((err) => {
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
        : "",
    "How to work:",
    "- First decide whether this task requires changing code in a repository. Some tasks (research, answering a question, planning) don't. If it doesn't, just do the work directly — don't load a repo or open a PR.",
    // A re-run's lead block above (reviewer feedback OR conflict resolution)
    // overrides this: only a FIRST attempt opens a new branch + PR; a re-run
    // checks out the existing PR's branch and pushes to it.
    "- If it DOES need code changes: use the `load_repo` tool to load the relevant repository, then make the change, commit on a new branch, push, and open a pull request. Only then does a PR apply.",
    "- Prefer the GitHub tool to open the PR. If it errors or targets the wrong repo, fall back to `git push` + the GitHub REST API (the auth token is embedded in the `origin` URL).",
    "- If a dev server is running it hot-reloads your changes — don't restart it, hunt for its port, or run a full typecheck/build just to verify a small edit.",
    "- Change only what the task needs. Don't trace the definition of a pre-existing symbol that's incidental to your change — note it in one line and move on. Prefer one or two broad searches over many narrow retries.",
    "- Only if you hit a genuine blocker a human must clear (see above) may you call `user_ask` — otherwise keep going and finish the task.",
    "",
    `(task id: ${task.id})`,
  ].join("\n");
}

export async function enqueueSuperAgentForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts?: SuperAgentPromptOpts,
): Promise<void> {
<<<<<<< HEAD
  // Sandbox-hosted claude-code takes the task when the org opted in AND the
  // repo is unambiguous — it must be chosen before dispatch (see
  // `claude-code-task-run.ts`). Anything else runs Decopilot exactly as before,
  // so no existing board behavior changes until both conditions hold.
  const repo = (await claudeCodeEnabledForOrg(ctx, task.organizationId))
    ? await resolveSoleTaskRepo(ctx, task.organizationId)
    : null;

  if (repo) {
    await enqueueAgentRunForTask(ctx, task, {
      title: `Super Agent: ${task.title}`,
      prompt: buildClaudeCodeTaskPrompt(task, repo, opts),
      temperature: 0.5,
      harnessId: "claude-code",
      repo,
    });
    return;
  }
||||||| parent of e7a75c589 (feat(billing): gate reports-task executions behind the org subscription)
  const prompt = buildSuperAgentTaskPrompt(task, opts);
=======
  // Quota claim at dispatch — the single funnel every execution path shares
  // (update flip, import auto-delegation, review/conflict re-runs, stall
  // recovery). Idempotent per task, so re-runs of a claimed task pass free;
  // an exhausted quota throws [SUBSCRIPTION_REQUIRED] and nothing enqueues.
  // The interactive flip pre-checks in TASK_BOARD_ITEM_UPDATE so the user
  // sees the paywall BEFORE the write; here the claim is the enforcement.
  await claimTaskExecution(ctx, task);

  const prompt = buildSuperAgentTaskPrompt(task, opts);
>>>>>>> e7a75c589 (feat(billing): gate reports-task executions behind the org subscription)

  await enqueueAgentRunForTask(ctx, task, {
    title: `Super Agent: ${task.title}`,
    prompt: buildSuperAgentTaskPrompt(task, opts),
    temperature: 0.5,
  });
}
