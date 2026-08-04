import { taskRunMetadata } from "../../billing/subsidized-runs";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { resolveTier } from "@/core/resolve-tier";
import { enqueueThreadRun } from "@/dispatch-queue";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { getDecopilotId } from "@decocms/shared/sdk";
import type { HostedHarnessId } from "@/api/routes/decopilot/dispatch-run";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { harnessRunsInSandbox } from "@/harnesses/sandbox-dispatch-client";
import type { TaskRepo } from "./claude-code-task-run";

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
  opts: {
    title: string;
    prompt: string;
    temperature: number;
    /** Hosted harness for this run. Defaults to Decopilot. */
    harnessId?: HostedHarnessId;
    /**
     * Repo to bind to the run's thread BEFORE dispatch. Required for
     * `claude-code`, which resolves its sandbox branch (and therefore its
     * checkout) at dispatch time and cannot pick a repo mid-run the way
     * Decopilot's `load_repo` does.
     */
    repo?: TaskRepo;
  },
): Promise<{ threadId: string }> {
  const organizationId = task.organizationId;
  const userId = task.assignedBy ?? task.createdBy;
  const harnessId = opts.harnessId ?? "decopilot";

  const model = await resolveTier(ctx, "smart");
  const agentId = getDecopilotId(organizationId);

  const thread = await ctx.storage.threads.create({
    organization_id: organizationId,
    title: opts.title,
    status: "in_progress",
    virtual_mcp_id: agentId,
    // Consume/terminal writer skips v1 threads — pin v2 or the run never completes.
    message_storage_version: 2,
    harness_id: harnessId,
    sandbox_provider_kind: "agent-sandbox",
    created_by: userId,
  });

  // Bind the repo to the thread the way `load_repo` does — it's the only place a
  // repo persists for the synthetic Super Agent, and it's what makes
  // `resolveSandboxBranch` hand this run a sandbox with the checkout in it. The
  // branch must be the repo-specific one or the run lands in the shared
  // "ephemeral" sandbox with no repo.
  //
  // `read_only` rides along on the same write: a sandbox-hosted harness answers
  // exactly the one prompt it was dispatched with, so a follow-up message would
  // sit in a queue nothing drains. The chat composer reads this and says so.
  const metadata = {
    ...(thread.metadata ?? {}),
    ...(harnessRunsInSandbox(harnessId) ? { read_only: true } : {}),
    ...(opts.repo
      ? {
          githubRepo: {
            url: opts.repo.url,
            owner: opts.repo.owner,
            name: opts.repo.name,
            installationId: opts.repo.installationId,
            connectionId: opts.repo.connectionId,
          },
        }
      : {}),
  };
  await ctx.storage.threads.update(thread.id, {
    metadata,
    ...(opts.repo
      ? { branch: threadBranch(thread.id, opts.repo.connectionId) }
      : {}),
    updated_by: userId,
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
      harnessId,
      sandboxProviderKind: "agent-sandbox",
      taskId: thread.id,
      // Reports tasks carry the subscription-billing stamp: their AI usage
      // is included in the org subscription (billing/subsidized-runs.ts).
      runMetadata: taskRunMetadata(task),
    },
  });

  return { threadId: thread.id };
}
