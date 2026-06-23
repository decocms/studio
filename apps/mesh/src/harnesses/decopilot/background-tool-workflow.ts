/**
 * Background-tool DBOS workflow.
 *
 * Some built-in tools (today: `generate_image`) are slow enough that running
 * them inline freezes the user's turn — and the per-thread gate — until they
 * finish. A backgroundable tool instead enqueues this workflow and returns a
 * "started" handle immediately (see `makeBackgroundable` in the harness), so
 * the turn completes and the thread keeps accepting messages. This workflow
 * then, durably and on any pod:
 *
 *   1. `runHeavyTool`   — re-run the tool's heavy body (memoized as a DBOS step,
 *                          so a replay returns the recorded result rather than
 *                          regenerating a different image).
 *   2. `appendResult`   — append the result to the thread as an assistant
 *                          message (renders via the normal generate_image card).
 *   3. react            — re-enter the per-thread gate via `enqueueThreadRun`
 *                          so the agent acknowledges/continues. Serialized
 *                          behind any in-flight user turn by the gate.
 *
 * No bespoke job table: DBOS owns durability (replay), idempotency (step
 * memoization), status (`listWorkflows`) and cancellation (`cancelWorkflow`).
 * The `jobId` is the workflow id; it is surfaced on the started tool result.
 *
 * Runtime deps (the mesh-context factory) are wired via `setBackgroundToolRuntime`
 * BEFORE `DBOS.launch()`. The workflow is registered at import time so the
 * recovery executor can replay it after a crash.
 */

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { enqueueThreadRun } from "@/dispatch-queue";
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

/** Background-tool jobs run on one partitioned queue, partitioned by orgId —
 *  same fairness model as automations: a saturated org blocks only its own
 *  partition. The reaction turn hops to the thread-gate, not this queue. The
 *  name lives in the side-effect-free `queue-names` module so `index.ts` can
 *  put it in the worker pod-role listen filter without importing this module
 *  (which registers a workflow at import time). */
export { BACKGROUND_TOOLS_QUEUE } from "@/dispatch-queue/queue-names";
import { BACKGROUND_TOOLS_QUEUE } from "@/dispatch-queue/queue-names";
/** Per-org (per-partition) concurrency cap for heavy background tool runs. */
export const BACKGROUND_TOOLS_PARTITION_CONCURRENCY = 5;

/**
 * Thread snapshot captured at the originating turn, carried so the reaction
 * turn can be rebuilt on any pod. Only serializable primitives — the model
 * config (incl. the image credential) is re-resolved from the org's tiers in
 * the workflow, the same way interactive chat and automations do, which keeps
 * a single `ModelsConfig` type across the heavy step and the reaction request.
 */
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
  /** DBOS system-database URL (ssl-resolved), used to enqueue the job via a
   *  decoupled `DBOSClient` — `DBOS.startWorkflow` is illegal from inside the
   *  agent-loop step that fires the backgroundable tool. */
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

/**
 * Decoupled enqueue client. The backgroundable tool fires from within the
 * thread-gate's `dispatchRunAndWait` step, and DBOS forbids starting/enqueuing
 * a workflow from inside a step. `DBOSClient.enqueue` writes the queue row
 * directly to the system DB, which is legal from anywhere; the launched
 * executor then dequeues and runs `backgroundToolWorkflow` normally. Created
 * lazily (first enqueue is post-launch, so the `dbos` schema exists) and reused.
 */
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

/**
 * Re-resolve the org's chat + image tiers into a `ModelsConfig`, mirroring the
 * interactive chat path (`resolvePerRequestModels`) and automations. The chat
 * tier defaults to "smart" — the reaction is a brief acknowledgement turn, so
 * the exact thinking model isn't load-bearing; the image tier is what the
 * heavy step activates. `web_research` is resolved too so the reaction turn
 * keeps the same tool surface as a normal chat turn.
 */
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

/**
 * Per-tool heavy-work implementation. `run` executes in WORKFLOW context: it
 * issues its own `DBOS.runStep`s for non-deterministic/external work (so a
 * replay returns recorded results instead of re-running) and appends output
 * through the `job` sink. Returns the models it resolved for the reaction turn
 * to reuse. `generate_image` is the one-shot case (one heavy step, one final
 * append); streaming tools (bash, subtask) will emit incrementally here.
 */
interface BackgroundProducer {
  run(
    job: BackgroundJob,
  ): Promise<{ models: ModelsConfig; reactionNudge: string | null }>;
}

/** Workflow-provided context + parts sink handed to each producer. */
interface BackgroundJob {
  ctx: BackgroundToolContext;
  /** Rebuild the org mesh context (call inside your own step). */
  meshContext(): Promise<StudioContext>;
  /** Append the job's terminal assistant message (parts + finish anchor) as a
   *  recorded `appendResult` step. */
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

  // A backgrounded `subtask` is dispatched as its OWN serialized run on the
  // parent thread. The thread-gate's per-thread concurrency=1 keeps it from
  // overlapping the main turn or any other run, so its stream never collides
  // with theirs (the bug that interleaved chunks + orphaned text parts). It runs
  // fresh (`isSubagent`: no parent history, `subtask` excluded, capped steps),
  // and the normal run pipeline streams it live + persists it — no manual chunk
  // plumbing, correct framing, survives refresh.
  subtask: {
    run: async (job) => {
      const cfg = await DBOS.runStep(
        () => resolveSubagentRunConfigStep(job.ctx),
        { name: "resolveSubagentRun" },
      );
      // Enqueued from WORKFLOW context (DBOS.startWorkflow is legal here, not in
      // a step). Idempotent workflow id ⇒ a replay collapses onto the same run.
      await enqueueThreadRun(
        {
          threadId: job.ctx.threadId,
          request: {
            messages: [
              {
                id: `${job.ctx.jobId}:prompt`,
                role: "user",
                // `internal` hides the prompt from the UI; the subagent still
                // receives it. The subagent's streamed reply is the visible part.
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
            // Correlates the run's messages to the subtask tool-call card
            // (`output.jobId`) so the UI nests them there.
            subtaskJobId: job.ctx.jobId,
            maxAgentSteps: SUBAGENT_STEP_LIMIT,
          },
          source: "background-tool",
        },
        { workflowID: `${job.ctx.jobId}:subagent` },
      );
      // Resume the parent agent once the subagent finishes. The reaction turn
      // is enqueued (by `reactStep`) AFTER the subagent run above, on the same
      // thread-gate partition (concurrency=1, FIFO), so the gate runs it only
      // when the subagent has terminated — by which point its messages are in
      // the thread history for the parent to read.
      return {
        models: cfg.models,
        reactionNudge:
          "The background subtask you started has completed; its result is now in the conversation above. Review it and continue with the user's request — do NOT call subtask again for this.",
      };
    },
  },
};

/**
 * Resolve what a backgrounded subtask's serialized run needs: the org model
 * config, the target agent (self-clone — `agent_id` omitted/== caller —
 * resolves to the caller), and the dispatch target + harness inherited from the
 * parent thread. A `DBOS.runStep` so the DB reads + tier resolution are
 * journaled (and not re-done on replay).
 */
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
  const target = resolveDispatchTarget({
    sandboxProviderKind: (parent?.sandbox_provider_kind ??
      "agent-sandbox") as never,
  });
  const harnessId = (parent?.harness_id ?? "decopilot") as HarnessId;
  return { prompt: input.prompt, models, targetAgentId, target, harnessId };
}

/**
 * `generate_image` heavy body. Memoized by DBOS as the `runHeavyTool` step: on
 * replay the recorded result is returned, so the (non-idempotent) image
 * generation never runs twice. Resolves the org's model tiers and returns BOTH
 * the small URI-bearing result and the resolved `models` so the reaction turn
 * reuses the same config without a second resolution.
 */
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

/**
 * Append the job's terminal assistant message via the stream-of-record
 * `PartEmitter` — the exact shape the live tool emits, so the UI renders it
 * through the normal card. Message id is derived from the jobId (deterministic)
 * so a step replay can't mint a duplicate message.
 */
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

/**
 * Resolve the reaction turn's dispatch target + harness from the thread row.
 * Hosted threads → agent-sandbox; desktop-linked threads → the user's daemon
 * (so the reaction runs where the thread runs, not hosted). Optimistic: no
 * liveness check — a dead desktop link surfaces as "not connected" downstream,
 * same as a normal chat turn. Returns null only when the mesh context can't be
 * rebuilt for the org.
 */
async function resolveReactionTargetStep(
  ctx: BackgroundToolContext,
): Promise<{ target: DispatchTarget; harnessId: HarnessId | null } | null> {
  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(ctx.orgId, ctx.userId);
  if (!meshCtx) return null;
  const thread = await meshCtx.storage.threads.get(ctx.threadId);
  const target = resolveDispatchTarget({
    sandboxProviderKind: (thread?.sandbox_provider_kind ??
      "agent-sandbox") as never,
  });
  const harnessId = (thread?.harness_id ?? "decopilot") as HarnessId;
  return { target, harnessId };
}

/**
 * Re-enter the per-thread gate so the agent reacts to the delivered result.
 * The trigger message rides the request's first non-system message (the only
 * non-system message dispatch persists/forwards). Serialized behind any
 * in-flight user turn by the gate (partition concurrency = 1).
 */
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
      request: {
        messages: [
          {
            // Deterministic id (a workflow replay must not mint a new one) and
            // `internal` so the UI hides this nudge — the model still sees it.
            id: `${ctx.jobId}:react-msg`,
            role: "user",
            metadata: { internal: true },
            parts: [{ type: "text", text: reactionNudge }],
          },
          // biome-ignore lint/suspicious/noExplicitAny: ChatMessage part union is built from the cluster tool set
        ] as any,
        models,
        agent: { id: ctx.agentId },
        temperature: ctx.temperature,
        toolApprovalLevel: ctx.toolApprovalLevel,
        mode: "default",
        organizationId: ctx.orgId,
        userId: ctx.userId,
        taskId: ctx.threadId,
        branch: ctx.branch ?? undefined,
        // Flags the resumed turn so the UI shows a "resumed after background
        // tool" indicator on the message.
        resumedFromBackground: true,
        // Route the reaction to where the thread runs (hosted vs the user's
        // desktop link). Omitting it would default to agent-sandbox and run a
        // desktop-pinned thread hosted.
        target: reaction.target,
        harnessId: reaction.harnessId ?? undefined,
      },
      source: "background-tool",
    },
    // Idempotent: a replay re-enqueues the same workflow id, collapsing onto
    // the existing reaction run instead of spawning a duplicate.
    { workflowID: `${ctx.jobId}:react` },
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
  // `enqueueThreadRun` is fire-and-forget (starts a workflow, doesn't await it),
  // so the reaction runs from the body rather than as a recorded step. A `null`
  // nudge skips the reaction turn entirely (no producer does today).
  if (reactionNudge) await reactStep(ctx, models, reactionNudge);
}

// Registered at import time so the executor can dequeue (and recover) it; we
// enqueue by name via DBOSClient, so the returned handle isn't needed here.
DBOS.registerWorkflow(backgroundToolWorkflowFn, {
  name: "backgroundToolWorkflow",
});

/**
 * Build a `BackgroundDispatcher` bound to the originating turn's thread/model
 * snapshot. Each `start()` mints a jobId (== workflow id) and enqueues the
 * workflow on the org's partition, returning the handle for the started tool
 * result. Cluster-only — desktop/tests pass no dispatcher and tools run inline.
 */
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
