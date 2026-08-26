/**
 * Send ONE more user turn onto an existing task run's thread, preserving its
 * context.
 *
 * Shared by the two callers that need it: the board-open stall recovery (finish
 * what you started) and the reviewer comment enforcement (record your pass).
 * Everything is keyed off (caller-chosen) ids rather than fresh ones — the
 * message id makes the part write idempotent and the `workflowID` makes the
 * enqueue collapse — so a caller that re-runs every minute forever still
 * produces exactly one extra run. That is also why neither caller needs an
 * "already nudged" marker of its own.
 */

import { taskRunMetadata } from "@/billing/subsidized-runs";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { resolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { enqueueThreadRun } from "@/dispatch-queue";
import {
  RUN_CLASS_METADATA_KEY,
  type RunClass,
} from "@/dispatch-queue/run-priority";
import type { TaskBoardItem, Thread } from "@/storage/types";
import { getDecopilotId } from "@decocms/shared/sdk";

export async function nudgeThreadTurn(
  ctx: StudioContext,
  item: TaskBoardItem,
  thread: Thread,
  opts: {
    /** Deterministic message id — makes the persisted user turn idempotent. */
    messageId: string;
    prompt: string;
    /** Deterministic run workflow id — the once-only fence. */
    workflowID: string;
    runClass?: RunClass;
    /** Per-run agent overrides, read only by the sandbox harness — a reviewer
     *  follow-up keeps the reviewer's tool denylist. */
    agent?: { instructions?: string; disallowedTools?: string[] };
  },
): Promise<void> {
  const organizationId = item.organizationId;
  const model = await resolveTier(ctx, "smart");
  const agentId = thread.virtual_mcp_id ?? getDecopilotId(organizationId);

  const requestMessage = {
    id: opts.messageId,
    role: "user" as const,
    parts: [{ type: "text" as const, text: opts.prompt }],
  };

  // Persist the user turn before dispatch, for the same ordering reason as
  // `enqueueAgentRunForTask`: the projector can otherwise land the reply first
  // and invert the two in the UI.
  await new PartEmitter({
    storage: ctx.storage.threads.messageParts(),
    orgId: organizationId,
    threadId: thread.id,
    runId: thread.id,
  }).emitRequestMessage(requestMessage);

  await enqueueThreadRun(
    {
      threadId: thread.id,
      source: "background-tool",
      request: {
        messages: [requestMessage],
        models: {
          credentialId: model.credentialId,
          thinking: { id: model.modelId, title: model.modelMeta.title },
        },
        agent: { id: agentId, ...(opts.agent ?? {}) },
        temperature: 0.5,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId,
        userId: item.assignedBy ?? item.createdBy,
        // The thread's OWN runtime, not a hardcoded Decopilot: a Super Agent
        // task on an org with a repo runs `claude-code`, and dispatching it as
        // Decopilot would answer with a different agent than the one that did
        // the work.
        harnessId:
          thread.harness_id === "claude-code" ? "claude-code" : "decopilot",
        // The branch the previous run was dispatched on, so the re-prompt lands
        // in a sandbox on the SAME checkout (`resolveSandboxBranch` needs the
        // explicit bare `thread:<id>` key for a run that started repo-less and
        // bound one mid-run with `TASK_ADD_REPO`; every other case re-derives
        // to the same value).
        ...(thread.branch ? { branch: thread.branch } : {}),
        taskId: thread.id,
        runMetadata: {
          ...taskRunMetadata(item),
          ...(opts.runClass ? { [RUN_CLASS_METADATA_KEY]: opts.runClass } : {}),
        },
      },
    },
    { workflowID: opts.workflowID },
  );
}
