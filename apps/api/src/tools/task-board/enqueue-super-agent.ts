import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { enqueueAgentRunForTask } from "./enqueue-task-run";

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
 * well-known Decopilot agent) on it via the durable thread-gate queue. Returns
 * the run's thread id, which a caller that wants the answer back (an
 * `@`-mention in a comment) stores on its own row.
 *
 * `prompt` overrides the delegation prompt — a comment mention asks its own
 * question instead of "complete this task". `runMetadata` adds run-scoped keys
 * on top of the task id (a comment mention pins the comment it must answer,
 * which is also what registers the `reply_comment` built-in for that run).
 *
 * ponytail: deliberately the simplest thing that runs the agent on the task —
 * a single text message, smart tier, no tool allowlist. Iterate on the prompt,
 * model, and metadata from here.
 */
export async function enqueueSuperAgentForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts?: {
    /** A reviewer's change request — leads the re-run prompt. */
    feedback?: string;
    /** The PR already under review, so the re-run updates it in place instead
     *  of opening a second PR. */
    pr?: { number: number; url: string };
    /** Overrides the delegation prompt — a comment mention asks its own
     *  question instead of "complete this task". */
    prompt?: string;
    runMetadata?: Record<string, string>;
    /** See `enqueueAgentRunForTask`. */
    linkThread?: boolean;
    /** See `enqueueAgentRunForTask`. */
    threadId?: string;
  },
): Promise<string> {
  // Guidance tuned from observed runs. First: let the agent judge whether the
  // task even touches a repo — not every task does, and forcing a PR on a
  // research/answer task made it invent code changes. Only when it works on a
  // repo does the commit/push/PR flow apply. Then keep it direct: don't hunt for
  // the dev-server port, don't chase incidental symbols. Keep it tight — a
  // bloated prompt costs tokens every step.
  const prompt =
    opts?.prompt ??
    [
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
      // When a reviewer bounced the task back, its feedback is the whole point of
      // this re-run — lead with it so the model addresses it (and updates the
      // EXISTING PR), not re-does the task from scratch or opens a second PR.
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
      // The reviewer-feedback block above overrides this for a re-run: only a
      // FIRST attempt opens a new branch + PR; a re-run pushes to the PR's branch.
      "- If it DOES need code changes: use the `load_repo` tool to load the relevant repository, then make the change, commit on a new branch, push, and open a pull request. Only then does a PR apply.",
      "- Prefer the GitHub tool to open the PR. If it errors or targets the wrong repo, fall back to `git push` + the GitHub REST API (the auth token is embedded in the `origin` URL).",
      "- If a dev server is running it hot-reloads your changes — don't restart it, hunt for its port, or run a full typecheck/build just to verify a small edit.",
      "- Change only what the task needs. Don't trace the definition of a pre-existing symbol that's incidental to your change — note it in one line and move on. Prefer one or two broad searches over many narrow retries.",
      "- Only if you hit a genuine blocker a human must clear (see above) may you call `user_ask` — otherwise keep going and finish the task.",
      "",
      `(task id: ${task.id})`,
    ].join("\n");

  const { threadId } = await enqueueAgentRunForTask(ctx, task, {
    title: `Super Agent: ${task.title}`,
    prompt,
    temperature: 0.5,
    runMetadata: opts?.runMetadata,
    linkThread: opts?.linkThread,
    threadId: opts?.threadId,
  });

  return threadId;
}
