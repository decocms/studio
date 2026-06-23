/**
 * Background-tool DBOS workflow: runs a slow built-in (generate_image, subtask)
 * off the user's turn, then re-enters the thread-gate to let the agent react.
 * DBOS owns durability/idempotency/status — no bespoke job table; `jobId` is
 * the workflow id. Deps wired via `setBackgroundToolRuntime` before launch.
 */

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  enqueueThreadRun,
  THREAD_GATE_QUEUE,
  type ThreadGateContext,
} from "@/dispatch-queue";
import type { StudioContextFactory } from "@/automations/fire";
import type { ModelInfo, ModelsConfig } from "@/api/routes/decopilot/types";
import { resolveTier, tryResolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { SUBAGENT_STEP_LIMIT } from "@decocms/harness/decopilot/prompt-constants";
import {
  resolveDispatchTarget,
  type DispatchTarget,
} from "@/links/resolve-dispatch-target";
import type { HarnessId } from "@decocms/harness/types";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import type { AnyMessage } from "@/api/routes/decopilot/part-row-builder";
import { getSettings } from "@/settings";
import type { ToolApprovalLevel } from "@decocms/harness/decopilot/mcp-tools";
import type { BackgroundDispatcher } from "@decocms/harness/decopilot/built-in-tools/backgroundable";
import {
  generateImageCore,
  type GenerateImageInput,
  type GenerateImageResult,
} from "@decocms/harness/decopilot/built-in-tools/portable-media-tools";

// Re-export from the side-effect-free `queue-names` module so `index.ts` can
// reference the name without importing this module (which registers a workflow).
export { BACKGROUND_TOOLS_QUEUE } from "@/dispatch-queue/queue-names";
import { BACKGROUND_TOOLS_QUEUE } from "@/dispatch-queue/queue-names";
/** Per-org (per-partition) concurrency cap for heavy background tool runs. */
export const BACKGROUND_TOOLS_PARTITION_CONCURRENCY = 5;

/** Serializable thread snapshot carried so the reaction turn can be rebuilt on
 *  any pod. Models are re-resolved in-workflow, not carried. */
export interface BackgroundToolSnapshot {
  threadId: string;
  orgId: string;
  userId: string;
  agentId: string;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  branch: string | null;
}

export interface BackgroundToolContext extends BackgroundToolSnapshot {
  /** DBOS workflow id == jobId, surfaced on the started tool result. */
  jobId: string;
  /** Backgroundable tool name (routes to the heavy fn). */
  toolName: string;
  /** Model-supplied tool input. */
  input: unknown;
  /** Originating tool call id (correlation). */
  toolCallId: string;
}

export interface BackgroundToolRuntime {
  meshContextFactory: StudioContextFactory;
  /** Enqueue via a decoupled `DBOSClient` — `DBOS.startWorkflow` is illegal
   *  inside the agent-loop step that fires the backgroundable tool. */
  systemDatabaseUrl: string;
}

let runtime: BackgroundToolRuntime | null = null;

export function setBackgroundToolRuntime(rt: BackgroundToolRuntime): void {
  runtime = rt;
}

function requireRuntime(): BackgroundToolRuntime {
  if (!runtime) {
    throw new Error(
      "[background-tool] DBOS runtime not initialized — setBackgroundToolRuntime() must run before workflows fire",
    );
  }
  return runtime;
}

// `DBOSClient.enqueue` writes the queue row directly to the system DB, legal
// from inside a step (unlike `DBOS.startWorkflow`). Lazy + reused.
let dbosClientPromise: Promise<DBOSClient> | null = null;

function getDbosClient(): Promise<DBOSClient> {
  dbosClientPromise ??= DBOSClient.create({
    systemDatabaseUrl: requireRuntime().systemDatabaseUrl,
    systemDatabaseSchemaName: "dbos",
  });
  return dbosClientPromise;
}

function toModelInfo(
  resolved: Awaited<ReturnType<typeof resolveTier>>,
): ModelInfo {
  const caps = resolved.modelMeta.capabilities;
  return {
    id: resolved.modelId,
    title: resolved.modelMeta.title ?? resolved.modelId,
    provider: resolved.modelMeta.providerId ?? null,
    capabilities:
      caps && caps.length > 0
        ? {
            vision:
              caps.includes("vision") || caps.includes("image") || undefined,
            text: caps.includes("text") || undefined,
            reasoning: caps.includes("reasoning") || undefined,
          }
        : undefined,
    limits: resolved.modelMeta.limits
      ? {
          contextWindow: resolved.modelMeta.limits.contextWindow,
          maxOutputTokens:
            resolved.modelMeta.limits.maxOutputTokens ?? undefined,
        }
      : undefined,
  };
}

/** Re-resolve the org's chat ("smart") + image + web_research tiers into a
 *  `ModelsConfig`, same as the interactive chat path. */
async function resolveReactionModels(
  meshCtx: StudioContext,
): Promise<ModelsConfig> {
  const [chat, image, webResearch] = await Promise.all([
    resolveTier(meshCtx, "smart"),
    tryResolveTier(meshCtx, "image"),
    tryResolveTier(meshCtx, "web_research"),
  ]);
  return {
    credentialId: chat.credentialId,
    thinking: toModelInfo(chat),
    ...(image
      ? { image: { ...toModelInfo(image), credentialId: image.credentialId } }
      : {}),
    ...(webResearch
      ? {
          deepResearch: {
            ...toModelInfo(webResearch),
            credentialId: webResearch.credentialId,
          },
        }
      : {}),
  };
}

async function requireMeshContext(
  ctx: BackgroundToolContext,
): Promise<StudioContext> {
  const meshCtx = await requireRuntime().meshContextFactory(
    ctx.orgId,
    ctx.userId,
  );
  if (!meshCtx) {
    throw new Error(
      `[background-tool] mesh context unavailable for org ${ctx.orgId} user ${ctx.userId}`,
    );
  }
  return meshCtx;
}

// Subtask completion nudge — shared by the workflow subtask producer and the
// inline defer-to-background path (harness-deps).
export const SUBTASK_DONE_NUDGE =
  "The background subtask you started has completed; its result is now in the conversation above. Review it and continue with the user's request — do NOT call subtask again for this.";

/** Resolve a thread row's dispatch target + harness (hosted vs desktop link). */
export function resolveThreadTarget(
  thread:
    | { sandbox_provider_kind?: string | null; harness_id?: string | null }
    | null
    | undefined,
): { target: DispatchTarget; harnessId: HarnessId } {
  return {
    target: resolveDispatchTarget({
      sandboxProviderKind: (thread?.sandbox_provider_kind ??
        "agent-sandbox") as never,
    }),
    harnessId: (thread?.harness_id ?? "decopilot") as HarnessId,
  };
}

/** Build the reaction turn's dispatch request — an internal nudge the model
 *  sees but the user doesn't, routed where the thread runs. */
function buildReactionRequest(
  s: BackgroundToolSnapshot & { jobId: string },
  opts: {
    models: ModelsConfig;
    nudge: string;
    target: DispatchTarget;
    harnessId: HarnessId | null;
  },
): ThreadGateContext["request"] {
  return {
    messages: [
      {
        id: `${s.jobId}:react-msg`,
        role: "user",
        metadata: { internal: true },
        parts: [{ type: "text", text: opts.nudge }],
      },
      // biome-ignore lint/suspicious/noExplicitAny: ChatMessage part union is built from the cluster tool set
    ] as any,
    models: opts.models,
    agent: { id: s.agentId },
    temperature: s.temperature,
    toolApprovalLevel: s.toolApprovalLevel,
    mode: "default",
    organizationId: s.orgId,
    userId: s.userId,
    taskId: s.threadId,
    branch: s.branch ?? undefined,
    resumedFromBackground: true,
    target: opts.target,
    harnessId: opts.harnessId ?? undefined,
  };
}

/**
 * Per-tool heavy-work implementation. `run` executes in WORKFLOW context,
 * issuing its own `DBOS.runStep`s for non-deterministic work and appending
 * output through `job`. Returns the resolved models for the reaction turn.
 */
interface BackgroundProducer {
  run(
    job: BackgroundJob,
  ): Promise<{ models: ModelsConfig; reactionNudge: string | null }>;
}

/** Workflow-provided context + parts sink handed to each producer. */
interface BackgroundJob {
  ctx: BackgroundToolContext;
  meshContext(): Promise<StudioContext>;
  /** Append the job's terminal assistant message as a recorded step. */
  emitFinal(parts: AnyMessage["parts"]): Promise<void>;
}

function makeJob(ctx: BackgroundToolContext): BackgroundJob {
  return {
    ctx,
    meshContext: () => requireMeshContext(ctx),
    emitFinal: (parts) =>
      DBOS.runStep(() => appendPartsStep(ctx, parts), { name: "appendResult" }),
  };
}

const PRODUCERS: Record<string, BackgroundProducer> = {
  generate_image: {
    run: async (job) => {
      const heavy = await DBOS.runStep(() => runGenerateImageStep(job), {
        name: "runHeavyTool",
      });
      const input = job.ctx.input as GenerateImageInput;
      await job.emitFinal([
        {
          type: "tool-generate_image",
          toolCallId: `${job.ctx.jobId}:img`,
          state: "output-available",
          input: {
            prompt: input.prompt,
            ...(input.referenceImages
              ? { referenceImages: input.referenceImages }
              : {}),
          },
          output: heavy.result,
        },
        // biome-ignore lint/suspicious/noExplicitAny: part shape is the cluster tool-part union
      ] as any);
      return {
        models: heavy.models,
        reactionNudge: `The image you generated in the background for "${input.prompt}" is ready and now shown to the user above. Briefly acknowledge it and continue — do NOT call generate_image again for this request.`,
      };
    },
  },

  // A backgrounded `subtask` runs as its OWN serialized run on the parent thread
  // (`isSubagent`, capped steps). The thread-gate's per-thread concurrency=1
  // keeps its stream from colliding with the main turn; `reactStep` (enqueued
  // after, FIFO) resumes the parent once it terminates and its messages land.
  subtask: {
    run: async (job) => {
      const cfg = await DBOS.runStep(
        () => resolveSubagentRunConfigStep(job.ctx),
        { name: "resolveSubagentRun" },
      );
      await enqueueThreadRun(
        {
          threadId: job.ctx.threadId,
          request: {
            messages: [
              {
                id: `${job.ctx.jobId}:prompt`,
                role: "user",
                metadata: { internal: true },
                parts: [{ type: "text", text: cfg.prompt }],
              },
              // biome-ignore lint/suspicious/noExplicitAny: ChatMessage union built from the cluster tool set
            ] as any,
            models: cfg.models,
            agent: { id: cfg.targetAgentId },
            temperature: job.ctx.temperature,
            toolApprovalLevel: "auto",
            mode: "default",
            organizationId: job.ctx.orgId,
            userId: job.ctx.userId,
            taskId: job.ctx.threadId,
            branch: job.ctx.branch ?? undefined,
            target: cfg.target,
            harnessId: cfg.harnessId ?? undefined,
            isSubagent: true,
            // Nests the run's messages under the subtask card (`output.jobId`).
            subtaskJobId: job.ctx.jobId,
            maxAgentSteps: SUBAGENT_STEP_LIMIT,
          },
          source: "background-tool",
        },
        { workflowID: `${job.ctx.jobId}:subagent` },
      );
      return { models: cfg.models, reactionNudge: SUBTASK_DONE_NUDGE };
    },
  },
};

/** Resolve a backgrounded subtask's serialized run: models, target agent
 *  (self-clone when `agent_id` omitted/== caller), target + harness from the
 *  parent thread. A `DBOS.runStep` so the reads are journaled. */
async function resolveSubagentRunConfigStep(
  ctx: BackgroundToolContext,
): Promise<{
  prompt: string;
  models: ModelsConfig;
  targetAgentId: string;
  target: DispatchTarget;
  harnessId: HarnessId | null;
}> {
  const meshCtx = await requireMeshContext(ctx);
  const input = ctx.input as { prompt: string; agent_id?: string };
  const isSelf = !input.agent_id || input.agent_id === ctx.agentId;
  const targetAgentId = isSelf ? ctx.agentId : input.agent_id!;
  const parent = await meshCtx.storage.threads.get(ctx.threadId);
  const models = await resolveReactionModels(meshCtx);
  return { prompt: input.prompt, models, targetAgentId, ...resolveThreadTarget(parent) };
}

/** `generate_image` heavy body, memoized as the `runHeavyTool` step so a replay
 *  never regenerates. Returns the result + resolved models for the reaction. */
async function runGenerateImageStep(
  job: BackgroundJob,
): Promise<{ result: GenerateImageResult; models: ModelsConfig }> {
  const meshCtx = await job.meshContext();
  const models = await resolveReactionModels(meshCtx);
  const image = models.image;
  if (!image?.credentialId) {
    throw new Error("[background-tool] no image model configured for org");
  }
  const provider = await meshCtx.aiProviders.activate(
    image.credentialId,
    job.ctx.orgId,
  );
  const result = await generateImageCore(job.ctx.input as GenerateImageInput, {
    provider,
    imageModelInfo: { id: image.id },
    objectStorage: meshCtx.objectStorage,
    allowHttpExternalUrls: getSettings().localMode,
  });
  return { result, models };
}

/** Append the job's terminal assistant message via `PartEmitter` (same shape as
 *  the live tool). Message id derived from jobId so a replay can't duplicate. */
async function appendPartsStep(
  ctx: BackgroundToolContext,
  parts: AnyMessage["parts"],
): Promise<void> {
  const meshCtx = await requireMeshContext(ctx);
  const thread = await meshCtx.storage.threads.get(ctx.threadId);
  if (!thread) {
    throw new Error(`[background-tool] thread ${ctx.threadId} not found`);
  }
  const emitter = new PartEmitter({
    storage: meshCtx.storage.threads.messageParts(),
    orgId: ctx.orgId,
    threadId: ctx.threadId,
    runId: ctx.jobId,
  });
  await emitter.emitFinal({
    id: `${ctx.jobId}:msg`,
    role: "assistant",
    parts,
  });
}

/** Resolve the reaction turn's target + harness from the thread row. Returns
 *  null only when the mesh context can't be rebuilt. */
async function resolveReactionTargetStep(
  ctx: BackgroundToolContext,
): Promise<{ target: DispatchTarget; harnessId: HarnessId | null } | null> {
  const meshCtx = await requireRuntime().meshContextFactory(
    ctx.orgId,
    ctx.userId,
  );
  if (!meshCtx) return null;
  return resolveThreadTarget(await meshCtx.storage.threads.get(ctx.threadId));
}

/** Re-enter the per-thread gate so the agent reacts to the delivered result.
 *  Serialized behind any in-flight user turn by the gate. Idempotent on
 *  `${jobId}:react` — a replay collapses onto the existing reaction run. */
async function reactStep(
  ctx: BackgroundToolContext,
  models: ModelsConfig,
  reactionNudge: string,
): Promise<void> {
  const reaction = await DBOS.runStep(() => resolveReactionTargetStep(ctx), {
    name: "resolveReactionTarget",
  });
  if (!reaction) return;
  await enqueueThreadRun(
    {
      threadId: ctx.threadId,
      request: buildReactionRequest(ctx, {
        models,
        nudge: reactionNudge,
        target: reaction.target,
        harnessId: reaction.harnessId,
      }),
      source: "background-tool",
    },
    { workflowID: `${ctx.jobId}:react` },
  );
}

/**
 * Resume the parent agent after an inline tool deferred mid-run (the `subtask`
 * "send to background" path) finished. Enqueues via the decoupled `DBOSClient`
 * because the caller (a detached drain) runs outside any workflow and may carry
 * a step's async-local context that would make `DBOS.startWorkflow` throw.
 * Idempotent on `${jobId}:react`.
 */
export async function resumeThreadAfterBackground(args: {
  meshCtx: StudioContext;
  threadId: string;
  orgId: string;
  userId: string;
  agentId: string;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  branch: string | null;
  target: DispatchTarget;
  harnessId: HarnessId | null;
  jobId: string;
  nudge: string;
}): Promise<void> {
  const models = await resolveReactionModels(args.meshCtx);
  const gateCtx: ThreadGateContext = {
    threadId: args.threadId,
    request: buildReactionRequest(args, {
      models,
      nudge: args.nudge,
      target: args.target,
      harnessId: args.harnessId,
    }),
    source: "background-tool",
  };
  const client = await getDbosClient();
  await client.enqueue(
    {
      workflowName: "threadGateWorkflow",
      queueName: THREAD_GATE_QUEUE,
      queuePartitionKey: args.threadId,
      workflowID: `${args.jobId}:react`,
    },
    gateCtx,
  );
}

async function backgroundToolWorkflowFn(
  ctx: BackgroundToolContext,
): Promise<void> {
  const producer = PRODUCERS[ctx.toolName];
  if (!producer) {
    throw new Error(`[background-tool] unknown tool "${ctx.toolName}"`);
  }
  const { models, reactionNudge } = await producer.run(makeJob(ctx));
  // A null nudge skips the reaction turn (no producer does today).
  if (reactionNudge) await reactStep(ctx, models, reactionNudge);
}

// Registered at import time so the executor can dequeue (and recover) it; we
// enqueue by name via DBOSClient, so the returned handle isn't needed here.
DBOS.registerWorkflow(backgroundToolWorkflowFn, {
  name: "backgroundToolWorkflow",
});

/** Cluster `BackgroundDispatcher` bound to the turn's snapshot. Each `start()`
 *  mints a jobId (== workflow id) and enqueues the workflow on the org partition. */
export function createBackgroundToolDispatcher(
  snapshot: BackgroundToolSnapshot,
): BackgroundDispatcher {
  return {
    start: async ({ toolName, input, toolCallId }) => {
      const jobId = crypto.randomUUID();
      const client = await getDbosClient();
      await client.enqueue<typeof backgroundToolWorkflowFn>(
        {
          workflowName: "backgroundToolWorkflow",
          queueName: BACKGROUND_TOOLS_QUEUE,
          queuePartitionKey: snapshot.orgId,
          workflowID: jobId,
        },
        { ...snapshot, jobId, toolName, input, toolCallId },
      );
      return { jobId };
    },
  };
}
