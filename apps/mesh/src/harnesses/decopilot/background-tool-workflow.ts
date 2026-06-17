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

import { DBOS } from "@dbos-inc/dbos-sdk";
import { enqueueThreadRun } from "@/dispatch-queue";
import type { StudioContextFactory } from "@/automations/fire";
import type { ModelInfo, ModelsConfig } from "@/api/routes/decopilot/types";
import { resolveTier, tryResolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import type { ThreadMessage } from "@/storage/types";
import {
  resolveDispatchTarget,
  type DispatchTarget,
} from "@/links/resolve-dispatch-target";
import type { LinkClaimRegistry } from "@/links/link-claim-registry";
import type { HarnessId } from "@decocms/harness/types";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
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
 *  partition. The reaction turn hops to the thread-gate, not this queue. */
export const BACKGROUND_TOOLS_QUEUE = "background-tools";
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
  /** Resolves the reaction turn's dispatch target — hosted threads get
   *  agent-sandbox, desktop-linked threads route back to the user's daemon. */
  linkClaimRegistry: LinkClaimRegistry;
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

/**
 * Run the tool's heavy body. Memoized by DBOS as a step: on replay the
 * recorded result is returned, so the (non-idempotent) image generation never
 * runs twice. Re-resolves the org's model tiers and returns BOTH the small
 * URI-bearing result and the resolved `models` so the reaction turn reuses the
 * same config without a second resolution.
 */
async function runHeavyToolStep(
  ctx: BackgroundToolContext,
): Promise<{ result: GenerateImageResult; models: ModelsConfig }> {
  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(ctx.orgId, ctx.userId);
  if (!meshCtx) {
    throw new Error(
      `[background-tool] mesh context unavailable for org ${ctx.orgId} user ${ctx.userId}`,
    );
  }
  if (ctx.toolName !== "generate_image") {
    throw new Error(`[background-tool] unknown tool "${ctx.toolName}"`);
  }
  const models = await resolveReactionModels(meshCtx);
  const image = models.image;
  if (!image?.credentialId) {
    throw new Error("[background-tool] no image model configured for org");
  }
  const provider = await meshCtx.aiProviders.activate(
    image.credentialId,
    ctx.orgId,
  );
  const result = await generateImageCore(ctx.input as GenerateImageInput, {
    provider,
    imageModelInfo: { id: image.id },
    objectStorage: meshCtx.objectStorage,
    allowHttpExternalUrls: getSettings().localMode,
  });
  return { result, models };
}

/**
 * Append the completed result to the thread as an assistant message carrying a
 * terminal `tool-generate_image` part — the exact shape the live tool emits, so
 * the UI renders it through the normal generate_image card. Version-aware: v2
 * threads use the stream-of-record `PartEmitter`, v1 threads the whole-message
 * `saveMessages`.
 */
async function appendResultStep(
  ctx: BackgroundToolContext,
  heavy: GenerateImageResult,
): Promise<void> {
  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(ctx.orgId, ctx.userId);
  if (!meshCtx) {
    throw new Error(
      `[background-tool] mesh context unavailable for org ${ctx.orgId}`,
    );
  }
  const thread = await meshCtx.storage.threads.get(ctx.threadId);
  if (!thread) {
    throw new Error(`[background-tool] thread ${ctx.threadId} not found`);
  }

  const messageId = crypto.randomUUID();
  const input = ctx.input as GenerateImageInput;
  const part = {
    type: "tool-generate_image",
    toolCallId: crypto.randomUUID(),
    state: "output-available",
    input: {
      prompt: input.prompt,
      ...(input.referenceImages
        ? { referenceImages: input.referenceImages }
        : {}),
    },
    output: heavy,
  };
  const message = { id: messageId, role: "assistant" as const, parts: [part] };

  if (thread.message_storage_version === 2) {
    const emitter = new PartEmitter({
      storage: meshCtx.storage.threads.messageParts(),
      orgId: ctx.orgId,
      threadId: ctx.threadId,
      runId: ctx.jobId,
    });
    await emitter.emitFinal(message);
    return;
  }

  const now = Date.now();
  await meshCtx.storage.threads.saveMessages([
    {
      ...message,
      thread_id: ctx.threadId,
      metadata: undefined,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    } as ThreadMessage,
  ]);
}

/**
 * Resolve the reaction turn's dispatch target + harness from the thread row.
 * Hosted threads → agent-sandbox; desktop-linked threads → the user's live
 * link daemon (so the reaction runs where the thread runs, not hosted). Runs
 * as a step so the (non-deterministic) registry lookup is journaled. Returns
 * null when the target can't be resolved (e.g. the desktop link went offline)
 * so the caller skips the reaction — the image is already delivered.
 */
async function resolveReactionTargetStep(
  ctx: BackgroundToolContext,
): Promise<{ target: DispatchTarget; harnessId: HarnessId | null } | null> {
  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(ctx.orgId, ctx.userId);
  if (!meshCtx) return null;
  const thread = await meshCtx.storage.threads.get(ctx.threadId);
  const kind = (thread?.sandbox_provider_kind ?? "agent-sandbox") as never;
  const harnessId = (thread?.harness_id ?? "decopilot") as HarnessId;
  const resolved = await resolveDispatchTarget(
    { harnessId, sandboxProviderKind: kind, userId: ctx.userId },
    { linkClaimRegistry: rt.linkClaimRegistry },
  );
  if (!resolved.ok) {
    console.warn(
      `[background-tool] reaction skipped for thread ${ctx.threadId} — dispatch target unavailable (${resolved.error.kind})`,
    );
    return null;
  }
  return { target: resolved.target, harnessId };
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
): Promise<void> {
  const reaction = await DBOS.runStep(() => resolveReactionTargetStep(ctx), {
    name: "resolveReactionTarget",
  });
  if (!reaction) return;
  const input = ctx.input as GenerateImageInput;
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
            parts: [
              {
                type: "text",
                text: `The image you generated in the background for "${input.prompt}" is ready and now shown to the user above. Briefly acknowledge it and continue — do NOT call generate_image again for this request.`,
              },
            ],
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
  const heavy = await DBOS.runStep(() => runHeavyToolStep(ctx), {
    name: "runHeavyTool",
  });
  await DBOS.runStep(() => appendResultStep(ctx, heavy.result), {
    name: "appendResult",
  });
  // `enqueueThreadRun` is fire-and-forget (starts a workflow, doesn't await it),
  // so it runs from the body rather than as a recorded step.
  await reactStep(ctx, heavy.models);
}

export const backgroundToolWorkflow = DBOS.registerWorkflow(
  backgroundToolWorkflowFn,
  { name: "backgroundToolWorkflow" },
);

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
      await DBOS.startWorkflow(backgroundToolWorkflow, {
        queueName: BACKGROUND_TOOLS_QUEUE,
        enqueueOptions: { queuePartitionKey: snapshot.orgId },
        workflowID: jobId,
      })({ ...snapshot, jobId, toolName, input, toolCallId });
      return { jobId };
    },
  };
}
