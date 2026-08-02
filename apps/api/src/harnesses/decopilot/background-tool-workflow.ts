/**
 * Background-tool DBOS workflow: runs a slow built-in (generate_image, subtask)
 * off the user's turn, then re-enters the thread-gate to let the agent react.
 * DBOS owns durability/idempotency/status — no bespoke job table; `jobId` is
 * the workflow id. Deps wired via `setBackgroundToolRuntime` before launch.
 */

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { enqueueThreadRun, type ThreadGateContext } from "@/dispatch-queue";
import type { StudioContextFactory } from "@/automations/fire";
import type { ModelInfo, ModelsConfig } from "@/api/routes/decopilot/types";
import { resolveTier, tryResolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { SUBAGENT_STEP_LIMIT } from "@decocms/harness/decopilot/prompt-constants";
import type { HarnessId } from "@decocms/harness/types";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import type { AnyMessage } from "@/api/routes/decopilot/part-row-builder";
import { getSettings } from "@/settings";
import type { ToolApprovalLevel } from "@decocms/harness/decopilot/mcp-tools";
import type { BackgroundDispatcher } from "@decocms/harness/decopilot/built-in-tools/backgroundable";
import {
  registerBackgroundAbort,
  unregisterBackgroundAbort,
} from "./background-abort-registry";
import {
  generateImageCore,
  type GenerateImageInput,
  type GenerateImageResult,
} from "@decocms/harness/decopilot/built-in-tools/portable-media-tools";
import { runAgentLoop } from "./run-agent-loop";
import { resolveSubagent } from "./resolve-subagent";
import { createSideChannelWriter } from "@decocms/harness/side-channel-writer";
import { ingestRun } from "@/api/routes/decopilot/ingest-run";
import type { StreamBuffer } from "@/api/routes/decopilot/stream-buffer";
import type { UIMessageChunk } from "ai";

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
  studioContextFactory: StudioContextFactory;
  /** Enqueue via a decoupled `DBOSClient` — `DBOS.startWorkflow` is illegal
   *  inside the agent-loop step that fires the backgroundable tool. */
  systemDatabaseUrl: string;
  /** Publishes a backgrounded subtask's live run to its own JetStream subject
   *  (`decopilot.stream.<jobId>`), so the client can tail it without touching
   *  the thread's single-writer stream. */
  streamBuffer: Pick<StreamBuffer, "publishRawChunk" | "publishDone">;
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

/** Re-resolve the org's chat ("smart") + image + web_search + deep_research
 *  tiers into a `ModelsConfig`, same as the interactive chat path. */
async function resolveReactionModels(
  studioCtx: StudioContext,
): Promise<ModelsConfig> {
  const [chat, image, webSearch, deepResearch] = await Promise.all([
    resolveTier(studioCtx, "smart"),
    tryResolveTier(studioCtx, "image"),
    tryResolveTier(studioCtx, "web_search"),
    tryResolveTier(studioCtx, "deep_research"),
  ]);
  return {
    credentialId: chat.credentialId,
    thinking: toModelInfo(chat),
    ...(image
      ? { image: { ...toModelInfo(image), credentialId: image.credentialId } }
      : {}),
    ...(webSearch
      ? {
          webSearch: {
            ...toModelInfo(webSearch),
            credentialId: webSearch.credentialId,
          },
        }
      : {}),
    ...(deepResearch
      ? {
          deepResearch: {
            ...toModelInfo(deepResearch),
            credentialId: deepResearch.credentialId,
          },
        }
      : {}),
  };
}

async function requireStudioContext(
  ctx: BackgroundToolContext,
): Promise<StudioContext> {
  const studioCtx = await requireRuntime().studioContextFactory(
    ctx.orgId,
    ctx.userId,
  );
  if (!studioCtx) {
    throw new Error(
      `[background-tool] studio context unavailable for org ${ctx.orgId} user ${ctx.userId}`,
    );
  }
  return studioCtx;
}

/** Resolve a thread row's harness. Every run is hosted in the cluster. */
function resolveThreadTarget(
  thread: { harness_id?: string | null } | null | undefined,
): { harnessId: HarnessId } {
  return { harnessId: (thread?.harness_id ?? "decopilot") as HarnessId };
}

/** Build the reaction turn's dispatch request — an internal nudge the model
 *  sees but the user doesn't, routed where the thread runs. */
function buildReactionRequest(
  s: BackgroundToolSnapshot & { jobId: string },
  opts: {
    models: ModelsConfig;
    nudge: string;
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
  studioContext(): Promise<StudioContext>;
  /** Append the job's terminal assistant message as a recorded step. */
  emitFinal(parts: AnyMessage["parts"]): Promise<void>;
}

function makeJob(ctx: BackgroundToolContext): BackgroundJob {
  return {
    ctx,
    studioContext: () => requireStudioContext(ctx),
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

  // A backgrounded `subtask` runs its subagent loop OFF the thread as a plain
  // workflow step (like generate_image), so it never occupies the per-thread
  // gate — the user keeps chatting while it works. Its report is delivered as a
  // message nested under the subtask card AND fed into the reaction nudge so the
  // parent model can actually use it (the inline path returns it as tool output;
  // this path has to hand it over explicitly).
  subtask: {
    run: async (job) => {
      // The step streams the subagent live to `decopilot.stream.<jobId>` and
      // persists its run (nested under the subtask card). It returns the report
      // so we can hand it to the parent — the inline path returns it as the
      // tool output; this path has to feed it into the reaction explicitly.
      const { report, finishReason, models } = await DBOS.runStep(
        () => runSubtaskStep(job.ctx),
        { name: "runSubtask" },
      );
      const hasReport = report.trim().length > 0;
      const reactionNudge = hasReport
        ? `The background subtask you started has completed. Its result:\n\n${report}\n\nUse this to continue with the user's request — do NOT call subtask again for this.`
        : `The background subtask you started completed but produced no usable output${finishReason === "length" ? " (it hit its step limit)" : ""}. Continue with the user's request without calling subtask again for this.`;
      return { models, reactionNudge };
    },
  },
};

/** Collect the assistant text from a folded final message. */
function extractAssistantText(
  message: { parts?: unknown[] } | undefined,
): string {
  if (!message?.parts) return "";
  return message.parts
    .map((p) =>
      p && typeof p === "object" && (p as { type?: string }).type === "text"
        ? ((p as { text?: string }).text ?? "")
        : "",
    )
    .filter((t) => t.trim().length > 0)
    .join("")
    .trim();
}

/**
 * Run a backgrounded subtask's subagent loop OFF the thread, streaming it live
 * to its OWN JetStream subject (`decopilot.stream.<jobId>`) and persisting its
 * messages (tagged `subtaskJobId`) — keyed by `jobId`, never the thread's id, so
 * it neither blocks the per-thread gate nor collides with the thread's own
 * stream/fence. Reuses the shared `ingestRun` publish+persist unit; the client's
 * per-job tail folds it into the subtask card. Returns the report for the
 * reaction nudge. A plain workflow step → memoized on replay.
 */
async function runSubtaskStep(
  ctx: BackgroundToolContext,
): Promise<{ report: string; finishReason: string; models: ModelsConfig }> {
  const studioCtx = await requireStudioContext(ctx);
  const organization = studioCtx.organization;
  if (!organization) {
    throw new Error(
      `[background-tool] organization context unavailable for subtask (org ${ctx.orgId})`,
    );
  }
  const input = ctx.input as { prompt: string; agent_id?: string };
  const isSelf = !input.agent_id || input.agent_id === ctx.agentId;
  const targetId = isSelf ? ctx.agentId : input.agent_id!;
  const models = await resolveReactionModels(studioCtx);
  const provider = await studioCtx.aiProviders.activate(
    models.credentialId,
    ctx.orgId,
  );
  // runAgentLoop wants the harness ModelsConfig (per-slot `credentialId`); the
  // cluster `resolveReactionModels` shape carries it at top level for `thinking`.
  const harnessModels = {
    thinking: { ...models.thinking, credentialId: models.credentialId },
    ...(models.image ? { image: models.image } : {}),
    ...(models.webSearch ? { webSearch: models.webSearch } : {}),
    ...(models.deepResearch ? { deepResearch: models.deepResearch } : {}),
  };
  const { mcpClient, targetKind, targetRef } = await resolveSubagent(
    studioCtx,
    ctx.orgId,
    targetId,
    { superUser: isSelf },
  );

  // Give the backgrounded subagent the SAME heavy built-ins the parent has
  // (vm file tools, generate_image, web_search) instead of the light core —
  // otherwise it only sees todo_write + read_tool_output and can't write files
  // or generate images. Providers + sandbox identity are rebuilt here since this
  // runs detached on a workflow step, not on the parent's turn.
  const imageInfo = harnessModels.image;
  const webSearchInfo = harnessModels.webSearch;
  const deepInfo = harnessModels.deepResearch;
  const imageProvider = imageInfo?.credentialId
    ? await studioCtx.aiProviders.activate(imageInfo.credentialId, ctx.orgId)
    : null;
  const webSearchProvider = webSearchInfo?.credentialId
    ? await studioCtx.aiProviders.activate(
        webSearchInfo.credentialId,
        ctx.orgId,
      )
    : null;
  const deepResearchProvider = deepInfo?.credentialId
    ? await studioCtx.aiProviders.activate(deepInfo.credentialId, ctx.orgId)
    : null;
  const subagentBuiltInParams = {
    provider,
    imageProvider,
    webSearchProvider,
    deepResearchProvider,
    organization,
    models: harnessModels,
    toolApprovalLevel: ctx.toolApprovalLevel,
    isPlanMode: false,
    passthroughClient: mcpClient as never,
    pendingImages: [],
    // Persisted agents may own a sandbox. A concrete MCP target is deliberately
    // connection-only: provisioning VM tools would reintroduce the Virtual MCP
    // row requirement this ephemeral path is designed to remove.
    vmContext:
      targetKind === "virtual-mcp"
        ? {
            virtualMcpId: targetRef.id,
            branch: targetRef.repo
              ? (ctx.branch ?? `thread:${ctx.threadId}`)
              : "ephemeral",
            userId: ctx.userId,
            threadId: ctx.threadId,
          }
        : null,
    taskId: ctx.threadId,
    agentId: targetRef.id,
    // Depth-1: a backgrounded subagent can't itself background/re-delegate.
    backgroundDispatcher: null,
  };
  // Nested tool chunks the subagent emits go to this discarded side channel;
  // the run's own message stream (text + tool calls) flows through
  // `toUIMessageStream` into the per-job subject below.
  const sideChannel = createSideChannelWriter();
  // Wire the run's abort to the thread-cancel path so cancelling the thread
  // stops the subtask too (the registry is fanned out over NATS).
  const abort = registerBackgroundAbort(ctx.threadId);
  let report = "";
  let finishReason = "stop";
  try {
    const handle = await runAgentLoop({
      kind: "subagent",
      ctx: studioCtx,
      organization,
      virtualMcp: targetRef,
      mcpClient: mcpClient as never,
      provider,
      models: harnessModels,
      messages: [{ role: "user", content: input.prompt }],
      systemAgentInstructions: targetRef.instructions,
      abortSignal: abort.signal,
      stepLimit: SUBAGENT_STEP_LIMIT,
      toolApprovalLevel: "auto",
      planMode: false,
      writer: sideChannel.writer,
      subtaskParams: {
        provider,
        organization,
        models: harnessModels,
        needsApproval: false,
      },
      passthroughClient: mcpClient as never,
      subagentBuiltInParams,
    });

    // Stamp `subtaskJobId` on the run's messages so the client nests them under
    // the originating subtask card.
    let msgN = 0;
    const uiStream = handle.result.toUIMessageStream({
      generateMessageId: () => `${ctx.jobId}:msg:${msgN++}`,
      messageMetadata: ({ part }: { part: { type: string } }) =>
        part.type === "start" ? { subtaskJobId: ctx.jobId } : undefined,
    }) as ReadableStream<UIMessageChunk>;

    let seq = 0;
    async function* seqChunks(): AsyncGenerator<{
      seq: number;
      chunk: UIMessageChunk;
    }> {
      const reader = uiStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield { seq: ++seq, chunk: value };
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Persist under runId=jobId but thread_id=the originating thread, so the
    // rows belong to the thread yet group under the job for nesting.
    const emitter = new PartEmitter({
      storage: studioCtx.storage.threads.messageParts(),
      orgId: ctx.orgId,
      threadId: ctx.threadId,
      runId: ctx.jobId,
    });

    await ingestRun(
      { runId: ctx.jobId, fenceToken: ctx.jobId, chunks: seqChunks() },
      {
        streamBuffer: requireRuntime().streamBuffer,
        persistence: emitter,
        title: {
          threadId: ctx.threadId,
          currentThreadTitle: undefined,
          // The job stream never sets the thread title.
          persistTitle: async () => {},
        },
        hooks: {
          onFinish: async (message, fr) => {
            const text = extractAssistantText(
              message as { parts?: unknown[] } | undefined,
            );
            if (text) report = text;
            if (fr) finishReason = fr;
          },
        },
      },
    );
    return { report, finishReason, models };
  } finally {
    sideChannel.close();
    unregisterBackgroundAbort(ctx.threadId, abort);
    await mcpClient.close().catch(() => {});
  }
}

/** `generate_image` heavy body, memoized as the `runHeavyTool` step so a replay
 *  never regenerates. Returns the result + resolved models for the reaction. */
async function runGenerateImageStep(
  job: BackgroundJob,
): Promise<{ result: GenerateImageResult; models: ModelsConfig }> {
  const studioCtx = await job.studioContext();
  const models = await resolveReactionModels(studioCtx);
  const image = models.image;
  if (!image?.credentialId) {
    throw new Error("[background-tool] no image model configured for org");
  }
  const provider = await studioCtx.aiProviders.activate(
    image.credentialId,
    job.ctx.orgId,
  );
  // Register an abort controller so a thread cancel (fanned out to this pod
  // over NATS → `abortBackgroundJobs`) stops the provider call in flight, not
  // just at the next DBOS step boundary.
  const ac = registerBackgroundAbort(job.ctx.threadId);
  try {
    const result = await generateImageCore(
      job.ctx.input as GenerateImageInput,
      {
        provider,
        imageModelInfo: { id: image.id },
        objectStorage: studioCtx.objectStorage,
        allowHttpExternalUrls: getSettings().localMode,
        abortSignal: ac.signal,
      },
    );
    return { result, models };
  } finally {
    unregisterBackgroundAbort(job.ctx.threadId, ac);
  }
}

/** Append the job's terminal assistant message via `PartEmitter` (same shape as
 *  the live tool). Message id derived from jobId so a replay can't duplicate. */
async function appendPartsStep(
  ctx: BackgroundToolContext,
  parts: AnyMessage["parts"],
): Promise<void> {
  const studioCtx = await requireStudioContext(ctx);
  const thread = await studioCtx.storage.threads.get(ctx.threadId);
  if (!thread) {
    throw new Error(`[background-tool] thread ${ctx.threadId} not found`);
  }
  const emitter = new PartEmitter({
    storage: studioCtx.storage.threads.messageParts(),
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
 * Deliver a DESKTOP-run background subtask's report. The subagent runs detached
 * on the daemon (real sandbox + vm/fs context), then the daemon calls the
 * `THREAD_SUBTASK_DELIVER` management tool, which calls this: persist the report
 * nested under the subtask card, then enqueue the reaction turn carrying the
 * report so the parent agent can act on it. (Cluster threads use the in-workflow
 * `runSubtaskStep` instead; desktop threads can't run the subagent on the
 * cluster because the sandbox is on the user's machine.)
 */
export async function deliverBackgroundSubtaskResult(args: {
  snapshot: BackgroundToolSnapshot;
  jobId: string;
  report: string;
}): Promise<void> {
  const { snapshot, jobId, report } = args;
  const ctx: BackgroundToolContext = {
    ...snapshot,
    jobId,
    toolName: "subtask",
    input: {},
    toolCallId: `${jobId}:deliver`,
  };
  const studioCtx = await requireStudioContext(ctx);
  const hasReport = report.trim().length > 0;

  // 1. Persist the report nested under the subtask card (metadata.subtaskJobId).
  const emitter = new PartEmitter({
    storage: studioCtx.storage.threads.messageParts(),
    orgId: snapshot.orgId,
    threadId: snapshot.threadId,
    runId: jobId,
  });
  await emitter.emitFinal({
    id: `${jobId}:result`,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: hasReport ? report : "_The subtask produced no output._",
      },
    ],
    metadata: { subtaskJobId: jobId },
    // biome-ignore lint/suspicious/noExplicitAny: AnyMessage doesn't declare metadata; the row builder persists it.
  } as any);

  // 2. Enqueue the reaction turn, carrying the report in the nudge.
  const models = await resolveReactionModels(studioCtx);
  const { harnessId } = resolveThreadTarget(
    await studioCtx.storage.threads.get(snapshot.threadId),
  );
  const nudge = hasReport
    ? `The background subtask you started has completed. Its result:\n\n${report}\n\nUse this to continue with the user's request — do NOT call subtask again for this.`
    : `The background subtask you started completed but produced no usable output. Continue with the user's request without calling subtask again for this.`;
  await enqueueThreadRun(
    {
      threadId: snapshot.threadId,
      request: buildReactionRequest(
        { ...snapshot, jobId },
        { models, nudge, harnessId },
      ),
      source: "background-tool",
    },
    { workflowID: `${jobId}:react` },
  );
}

/** Resolve the reaction turn's target + harness from the thread row. Returns
 *  null only when the studio context can't be rebuilt. */
async function resolveReactionTargetStep(
  ctx: BackgroundToolContext,
): Promise<{ harnessId: HarnessId | null } | null> {
  const studioCtx = await requireRuntime().studioContextFactory(
    ctx.orgId,
    ctx.userId,
  );
  if (!studioCtx) return null;
  return resolveThreadTarget(await studioCtx.storage.threads.get(ctx.threadId));
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
        harnessId: reaction.harnessId,
      }),
      source: "background-tool",
    },
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
  // A null nudge skips the reaction turn (no producer does today).
  if (reactionNudge) await reactStep(ctx, models, reactionNudge);
}

// Registered at import time so the executor can dequeue (and recover) it; we
// enqueue by name via DBOSClient, so the returned handle isn't needed here.
// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/api/src/dbos/workflow-version.ts.
DBOS.registerWorkflow(backgroundToolWorkflowFn, {
  name: "backgroundToolWorkflow",
});

/** Cancel every queued/in-flight background-tool workflow a thread started
 *  (image gen / backgrounded subtasks, plus their derived `:react`/`:subagent`
 *  runs). Called from the thread-cancel handler — these run on their own DBOS
 *  queue, so the in-memory run cancel never reaches them. The id prefix is the
 *  only index needed; DBOS interrupts a running workflow at its next step. */
export async function cancelThreadBackgroundJobs(
  threadId: string,
): Promise<void> {
  const active = await DBOS.listWorkflows({
    workflow_id_prefix: `bgtool:${threadId}:`,
    status: ["PENDING", "ENQUEUED"],
    loadInput: false,
    loadOutput: false,
  });
  if (active.length === 0) return;
  await DBOS.cancelWorkflows(active.map((w) => w.workflowID));
}

/** Cluster `BackgroundDispatcher` bound to the turn's snapshot. Each `start()`
 *  mints a jobId (== workflow id) and enqueues the workflow on the org partition. */
export function createBackgroundToolDispatcher(
  snapshot: BackgroundToolSnapshot,
): BackgroundDispatcher {
  return {
    start: async ({ toolName, input, toolCallId }) => {
      // Encode the threadId in the id so `cancelThreadBackgroundJobs` can find
      // this job (and its derived `:react`/`:subagent` runs) by prefix when the
      // thread is cancelled. `:` can't appear in a threadId, so the prefix
      // `bgtool:<threadId>:` won't match a different thread.
      const jobId = `bgtool:${snapshot.threadId}:${crypto.randomUUID()}`;
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
