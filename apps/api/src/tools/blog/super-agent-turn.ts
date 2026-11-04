import { createHash } from "node:crypto";
import { BLOG_JOB_THREAD_KEY, type BlogJob } from "@decocms/shared/blog-job";
import { getDecopilotId } from "@decocms/shared/sdk";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { enqueueThreadRun } from "@/dispatch-queue";
import { RUN_CLASS_METADATA_KEY } from "@/dispatch-queue/run-priority";
import {
  type ClaudeCodeEffort,
  claudeSubscriptionChatModel,
  EFFORT_METADATA_KEY,
  TASK_RUN_INSTRUCTIONS_KEY,
} from "@/harnesses/claude-code-env";
import { userPlanCredentialId } from "@/harnesses/sandbox-only-chats";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { resolveTaskRunModel } from "@/tools/task-board/task-run-harness";
import { TierUnavailableError } from "../../core/resolve-tier";
import type { StudioContext } from "../../core/studio-context";

/**
 * One turn of a Super Agent chat on Claude Code that Studio starts rather than
 * a person types: a blogpost card's phase, a brand fill, a campaigns proposal. The request is
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
    /** More reasoning than a run's low, for a turn whose output a reader judges. */
    effort?: ClaudeCodeEffort;
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
        runMetadata: {
          [RUN_CLASS_METADATA_KEY]: "new_task",
          ...(turn.effort ? { [EFFORT_METADATA_KEY]: turn.effort } : {}),
        },
      },
    },
    { workflowID: turn.fence },
  );
}

const MAX_TITLE_CHARS = 120;

/** Open a chat of its own for a blog job, marked so dispatch gives it the blog's connections, and start its first turn. */
export async function openBlogJobChat(
  ctx: StudioContext,
  chat: {
    organizationId: string;
    userId: string;
    /** Minted by the caller when a record has to name the chat before it exists. */
    threadId?: string;
    job: BlogJob;
    title: string;
    text: string;
    instructions?: string;
  },
): Promise<string> {
  const threadId = chat.threadId ?? crypto.randomUUID();
  const branch = threadBranch(threadId);
  await ctx.storage.threads.create({
    id: threadId,
    organization_id: chat.organizationId,
    title:
      chat.title.length > MAX_TITLE_CHARS
        ? `${chat.title.slice(0, MAX_TITLE_CHARS - 1)}…`
        : chat.title,
    status: "in_progress",
    virtual_mcp_id: getDecopilotId(chat.organizationId),
    // The terminal writer skips v1 threads, so a v1 run never ends.
    message_storage_version: 2,
    harness_id: "claude-code",
    created_by: chat.userId,
    branch,
    metadata: {
      runtime: "sandbox",
      [BLOG_JOB_THREAD_KEY]: chat.job,
      ...(chat.instructions
        ? { [TASK_RUN_INSTRUCTIONS_KEY]: chat.instructions }
        : {}),
    },
  });

  try {
    await dispatchSuperAgentTurn(ctx, {
      organizationId: chat.organizationId,
      userId: chat.userId,
      threadId,
      branch,
      text: chat.text,
      instructions: chat.instructions,
      fence: `${chat.job.kind}:${threadId}`,
      requestedAt: new Date().toISOString(),
    });
  } catch (err) {
    await ctx.storage.threads
      .delete(threadId)
      .catch((cleanup) =>
        console.error("[blog] job chat cleanup failed", cleanup),
      );
    throw err;
  }
  return threadId;
}
