import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { resolveTier } from "@/core/resolve-tier";
import { enqueueThreadRun } from "@/dispatch-queue";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { getDecopilotId } from "@decocms/shared/sdk";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

/**
 * The shared post-write reaction for a task delegated to the Super Agent:
 * enqueue the run. No-op for any other assignee, so callers that already know
 * the write delegated (create) and callers that gate on the transition
 * (update) share one body. The SSE broadcast is emitted by each write site
 * itself (every create/update broadcasts, not just delegations).
 *
 * Enqueue never fails the write (the task is already persisted), but the
 * failure is NOT swallowed silently: the reason (e.g. "no model configured for
 * tier smart") is returned so the tool can hand it back and the UI can tell the
 * user why the run didn't start, instead of leaving a task assigned-but-idle.
 * Returns null when there's nothing to report (not delegated, or started fine).
 */
export async function reactToSuperAgentDelegation(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<string | null> {
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return null;
  try {
    await enqueueAgentForTask(ctx, item);
    return null;
  } catch (err) {
    console.error("[task-board] Super Agent enqueue failed", err);
    return err instanceof Error
      ? err.message
      : "Failed to start the Super Agent";
  }
}

/**
 * Enqueue an agent run for a task. Creates a fresh thread seeded with the task
 * in context, then dispatches the agent on it via the durable thread-gate
 * queue. `agentVirtualMcpId` selects the agent (a column automation's
 * configured agent); omitted/null = the org's Super Agent (the well-known
 * Decopilot agent) — the assignee-delegation path.
 *
 * ponytail: deliberately the simplest thing that runs the agent on the task —
 * a single text message, smart tier, no tool allowlist. Iterate on the prompt,
 * model, and metadata from here.
 */
export async function enqueueAgentForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  agentVirtualMcpId?: string | null,
): Promise<void> {
  const organizationId = task.organizationId;
  const userId = task.assignedBy ?? task.createdBy;

  const model = await resolveTier(ctx, "smart");
  const agentId = agentVirtualMcpId ?? getDecopilotId(organizationId);

  const thread = await ctx.storage.threads.create({
    organization_id: organizationId,
    title: agentVirtualMcpId
      ? `Agent: ${task.title}`
      : `Super Agent: ${task.title}`,
    status: "in_progress",
    virtual_mcp_id: agentId,
    // Consume/terminal writer skips v1 threads — pin v2 or the run never completes.
    message_storage_version: 2,
    created_by: userId,
  });

  // Link the run thread to the task (many-to-many) so the board can render it
  // in the card and derive its live run state.
  await ctx.storage.taskBoard.linkThread(task.id, thread.id, organizationId);

  // Guidance tuned from observed runs. First: let the agent judge whether the
  // task even touches a repo — not every task does, and forcing a PR on a
  // research/answer task made it invent code changes. Only when it works on a
  // repo does the commit/push/PR flow apply. Then keep it direct: don't hunt for
  // the dev-server port, don't chase incidental symbols. Keep it tight — a
  // bloated prompt costs tokens every step.
  const prompt = [
    "You've been assigned this task. Complete it.",
    "",
    `Title: ${task.title}`,
    task.description ? `\nDescription:\n${task.description}\n` : "",
    "How to work:",
    "- First decide whether this task requires changing code in a repository. Some tasks (research, answering a question, planning) don't. If it doesn't, just do the work directly — don't load a repo or open a PR.",
    "- If it DOES need code changes: use the `load_repo` tool to load the relevant repository, then make the change, commit on a new branch, push, and open a pull request. Only then does a PR apply.",
    "- Prefer the GitHub tool to open the PR. If it errors or targets the wrong repo, fall back to `git push` + the GitHub REST API (the auth token is embedded in the `origin` URL).",
    "- If a dev server is running it hot-reloads your changes — don't restart it, hunt for its port, or run a full typecheck/build just to verify a small edit.",
    "- Change only what the task needs. Don't trace the definition of a pre-existing symbol that's incidental to your change — note it in one line and move on. Prefer one or two broad searches over many narrow retries.",
    "- If you're blocked on a decision or information only a human has, call the `user_ask` tool instead of guessing or stopping.",
    "",
    `(task id: ${task.id})`,
  ].join("\n");

  const requestMessage = {
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text" as const, text: prompt }],
  };

  // Persist the user turn BEFORE dispatch (as POST /messages does) so it lands
  // with an early created_at. The projector runs concurrently with the run's own
  // prepareRun user-message emit; if it projects the assistant reply first, that
  // reply gets base = Date.now() (no user parts yet) and the user message then
  // persists with a LATER created_at — inverting their order in the UI (the
  // request renders after the reply, trailed by "No response was generated").
  // Writing it here first guarantees user-before-assistant ordering. Idempotent:
  // the run's own emit reuses this same message id (ON CONFLICT keeps this row).
  await new PartEmitter({
    storage: ctx.storage.threads.messageParts(),
    orgId: organizationId,
    threadId: thread.id,
    runId: thread.id,
  }).emitRequestMessage(requestMessage);

  await enqueueThreadRun({
    threadId: thread.id,
    source: "background-tool",
    request: {
      messages: [requestMessage],
      models: {
        credentialId: model.credentialId,
        thinking: { id: model.modelId, title: model.modelMeta.title },
      },
      agent: { id: agentId },
      temperature: 0.5,
      toolApprovalLevel: "auto",
      mode: "default",
      organizationId,
      userId,
      taskId: thread.id,
      runMetadata: { taskBoardItemId: task.id },
    },
  });
}
