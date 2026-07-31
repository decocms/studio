import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { resolveTier } from "@/core/resolve-tier";
import { enqueueThreadRun } from "@/dispatch-queue";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { getDecopilotId } from "@decocms/shared/sdk";

/**
 * The single home for the "run the org's agent on a task" plumbing, shared by
 * the Super Agent and the reviewer enqueues (which used to duplicate it): create
 * a fresh thread, link it to the task, persist the seed user turn BEFORE
 * dispatch, then enqueue the run on the durable thread-gate queue. Callers vary
 * only the title, prompt, and temperature. Returns the run thread's id so the
 * caller can record follow-up activity / broadcast against it.
 */
export async function enqueueAgentRunForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts: { title: string; prompt: string; temperature: number },
): Promise<{ threadId: string }> {
  const organizationId = task.organizationId;
  const userId = task.assignedBy ?? task.createdBy;

  const model = await resolveTier(ctx, "smart");
  const agentId = getDecopilotId(organizationId);

  const thread = await ctx.storage.threads.create({
    organization_id: organizationId,
    title: opts.title,
    status: "in_progress",
    virtual_mcp_id: agentId,
    // Consume/terminal writer skips v1 threads — pin v2 or the run never completes.
    message_storage_version: 2,
    created_by: userId,
  });

  // Link the run thread to the task (many-to-many) so the board can render it
  // in the card and derive its live run state.
  await ctx.storage.taskBoard.linkThread(task.id, thread.id, organizationId);

  const requestMessage = {
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text" as const, text: opts.prompt }],
  };

  // Persist the user turn BEFORE dispatch (as POST /messages does) so it lands
  // with an early created_at. The projector runs concurrently with the run's own
  // prepareRun user-message emit; if it projects the assistant reply first, that
  // reply gets base = Date.now() (no user parts yet) and the user message then
  // persists with a LATER created_at — inverting their order in the UI. Writing
  // it here first guarantees user-before-assistant ordering. Idempotent: the
  // run's own emit reuses this same message id (ON CONFLICT keeps this row).
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
      temperature: opts.temperature,
      toolApprovalLevel: "auto",
      mode: "default",
      organizationId,
      userId,
      taskId: thread.id,
      runMetadata: { taskBoardItemId: task.id },
    },
  });

  return { threadId: thread.id };
}
