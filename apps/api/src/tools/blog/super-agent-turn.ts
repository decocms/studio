import { createHash } from "node:crypto";
import { getDecopilotId } from "@decocms/shared/sdk";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { enqueueThreadRun } from "@/dispatch-queue";
import { RUN_CLASS_METADATA_KEY } from "@/dispatch-queue/run-priority";
import { claudeSubscriptionChatModel } from "@/harnesses/claude-code-env";
import { userPlanCredentialId } from "@/harnesses/sandbox-only-chats";
import { resolveTaskRunModel } from "@/tools/task-board/task-run-harness";
import { TierUnavailableError } from "../../core/resolve-tier";
import type { StudioContext } from "../../core/studio-context";

/**
 * One turn of a Super Agent chat on Claude Code that Studio starts rather than
 * a person types: a blogpost card's phase, a brand guide's fill. The request is
 * written to the chat first, so the reply cannot be projected ahead of it, and
 * the run is queued behind a fence, so a retried start is the same run.
 */

/**
 * The run's model: the organization's, or with none the person's own Claude
 * plan, as a chat falls back to it. Dispatch bills the plan whenever there is
 * one; only an organization with neither cannot start the turn.
 */
async function turnModel(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
): Promise<{ credentialId: string; thinking: { id: string; title?: string } }> {
  try {
    const tier = await resolveTaskRunModel(
      ctx,
      organizationId,
      userId,
      "claude-code",
    );
    return {
      credentialId: tier.credentialId,
      thinking: { id: tier.modelId, title: tier.modelMeta.title },
    };
  } catch (err) {
    if (!(err instanceof TierUnavailableError)) throw err;
    const planId = await userPlanCredentialId(ctx, organizationId, userId);
    if (!planId) throw err;
    return claudeSubscriptionChatModel(planId);
  }
}

export async function dispatchSuperAgentTurn(
  ctx: StudioContext,
  turn: {
    organizationId: string;
    userId: string;
    threadId: string;
    /** The chat's sandbox key: the bare `thread:<id>`, which clones nothing. */
    branch: string;
    text: string;
    /** Rules every turn of this chat runs under, on top of the agent's own. */
    instructions?: string;
    /** Names the turn: a start retried with the same fence queues nothing new. */
    fence: string;
    requestedAt: string;
  },
): Promise<void> {
  const model = await turnModel(ctx, turn.organizationId, turn.userId);
  const requestMessage = {
    id: `turn-${createHash("sha256").update(turn.fence).digest("hex").slice(0, 32)}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text: turn.text }],
    // Stamped here: a turn without a timestamp sorts after its own reply.
    metadata: { created_at: turn.requestedAt },
  };
  await new PartEmitter({
    storage: ctx.storage.threads.messageParts(),
    orgId: turn.organizationId,
    threadId: turn.threadId,
    runId: turn.threadId,
  }).emitRequestMessage(requestMessage);

  await enqueueThreadRun(
    {
      threadId: turn.threadId,
      source: "background-tool",
      request: {
        messages: [requestMessage],
        models: {
          credentialId: model.credentialId,
          thinking: model.thinking,
        },
        agent: {
          id: getDecopilotId(turn.organizationId),
          ...(turn.instructions
            ? { appendInstructions: turn.instructions }
            : {}),
        },
        temperature: 0.5,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: turn.organizationId,
        userId: turn.userId,
        harnessId: "claude-code",
        branch: turn.branch,
        taskId: turn.threadId,
        runMetadata: { [RUN_CLASS_METADATA_KEY]: "new_task" },
      },
    },
    { workflowID: turn.fence },
  );
}
