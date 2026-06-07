/**
 * Dispatch Run
 *
 * The agent loop, decoupled from any transport.
 *
 *   dispatchRunAndWait(input, ctx, deps)
 *     Claims the run, drains `uiStream` internally until the run
 *     terminates, and resolves once it's done. Used by every entry point
 *     that initiates work (the per-thread DBOS workflow step that backs
 *     POST /messages, automation fires, pod-death recovery). When a
 *     `streamBuffer` is configured the run also pumps into JetStream so
 *     `/stream` tails see chunks live; without one the run still
 *     completes but its chunks are dropped.
 *
 * Architecture: dispatch-run owns the shared infrastructure (run-registry
 * lifecycle, memory load, JetStream buffering, registry FINISH dispatch,
 * posthog events). The actual streamText loop + tool assembly +
 * system-prompt construction is delegated to a Harness via
 * `localDispatch(harnessId, harnessInput, ctx)`. The three in-tree harnesses
 * (`decopilot`, `claude-code`, `codex`) each produce `UIMessageChunk`
 * streams that get merged into the outer `createUIMessageStream` writer;
 * the drain reader consumes the result.
 */

import type { StudioContext } from "@/core/studio-context";
import { posthog } from "@/posthog";
import { type UIMessageChunk, createUIMessageStream } from "ai";
import type { MeshProvider } from "@/ai-providers/types";
import { tryResolveTier, type ResolvedTier } from "@/core/resolve-tier";
import { localDispatch } from "@/harnesses";
import { remoteDispatch } from "@/harnesses/remote-dispatch";
import {
  offloadKey,
  sha256Hex,
  shouldOffload,
  type MessagesRef,
} from "@/harnesses/offload-messages";
import { ensureSandbox } from "@/tools/sandbox/start";
import { buildDesktopProvider } from "@/sandbox/lifecycle";
import { computeClaimHandle } from "@/sandbox/claim-handle";
import { composeSandboxRef } from "@decocms/sandbox/provider";
import {
  buildAnonymousCloneInfo,
  buildCloneInfo,
} from "@/shared/github-clone-info";
import { resolveRuntimeConfig } from "@/tools/sandbox/helpers";
import { deriveOffloadAllowlist } from "@/object-storage/offload-allowlist";
import { getSettings } from "@/settings";
import type { WorkItemSandbox } from "./link-work-queue";
import { createHtmlPageBuffer } from "@/harnesses/decopilot/built-in-tools/vm-tools/html-page-buffer";
import type { DispatchTarget } from "../../../links/resolve-dispatch-target";
import type {
  HarnessId,
  HarnessProcessLocal,
  HarnessStreamInput,
} from "@/harnesses";
import {
  sanitizeStreamError,
  stringifyError,
} from "@/harnesses/decopilot/stream-error";
import { DEFAULT_WINDOW_SIZE, generateMessageId } from "./constants";
import { loadAndMergeMessages } from "./conversation";
import { PartEmitter } from "./part-emitter";
import { ProgressBumpThrottle } from "./progress-bump";
import { uploadFileParts, resolveStorageRefs } from "./file-materializer";
import type { ToolApprovalLevel } from "./helpers";
import { type ChatMode } from "./mode-config";

export type { ChatMode } from "./mode-config";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import { buildOnTitleUpdated } from "./on-title-updated";
import { interceptTitleChunks } from "./title-interceptor";
import {
  checkModelPermission,
  fetchModelPermissions,
  filterToolTiersByPermission,
} from "./model-permissions";
import type { RunRegistry } from "./run-registry";
import { resolveThreadStatus } from "./status";
import type { StreamBuffer } from "./stream-buffer";
import type { ChatMessage, ModelsConfig } from "./types";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { ThreadMessage } from "@/storage/types";
import type { PendingImage } from "@/harnesses/decopilot/built-in-tools";
import { getInternalUrl, getPublicUrl } from "@/core/server-constants";
import { traced } from "@/observability";
import { getPodId } from "@/core/pod-identity";
import type { SSEEvent } from "@/event-bus";

/**
 * Process-wide progress-bump throttle (Task 9, A1/A2). One instance shared by
 * every run on this pod — it dedupes `last_progress_at` writes to ≤1 per ~3s
 * per task. Lives at module scope (not per-run) so its per-task last-bump map
 * survives across the multiple `prepareRun` invocations a thread may see.
 */
const progressThrottle = new ProgressBumpThrottle();

/**
 * Tap a UI stream so each chunk drives a THROTTLED `last_progress_at` bump.
 * Pure pass-through: every chunk is forwarded unchanged; the bump is a
 * fire-and-forget side effect that never blocks or fails the stream. This is
 * the run's liveness heartbeat — the reaper reads `last_progress_at` to decide
 * whether a run is stuck.
 */
function tapProgress(
  stream: ReadableStream<unknown>,
  ctx: StudioContext,
  taskId: string,
): ReadableStream<unknown> {
  return stream.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(chunk, controller) {
        if (progressThrottle.shouldBump(taskId)) {
          ctx.storage.threads.bumpProgress(taskId).catch(() => {
            // Heartbeat is best-effort; a failed bump just means the reaper
            // may rely on an older timestamp. Never surface to the stream.
          });
        }
        controller.enqueue(chunk);
      },
      flush() {
        // Run ended — drop this task's throttle state so the map can't grow
        // unbounded across many short-lived threads.
        progressThrottle.clear(taskId);
      },
    }),
  );
}

/**
 * Classify a stream error into a small, stable taxonomy for analytics.
 * Consumers (dashboards) can rely on these values being consistent across
 * providers — the raw error message stays in the separate `error_message`
 * prop for debugging.
 */
function classifyStreamError(
  error: unknown,
):
  | "aborted"
  | "insufficient_funds"
  | "rate_limit"
  | "timeout"
  | "auth"
  | "model_error"
  | "tool_error"
  | "unknown" {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const msg = (
    error instanceof Error ? error.message : stringifyError(error)
  ).toLowerCase();
  if (
    /insufficient|no credits|out of credits|balance|payment|quota exceeded|402/i.test(
      msg,
    )
  ) {
    return "insufficient_funds";
  }
  if (/rate.?limit|too many requests|429/i.test(msg)) return "rate_limit";
  if (/timeout|timed out|deadline/i.test(msg)) return "timeout";
  if (/unauthor|forbidden|401|403|invalid.*(key|token)/i.test(msg))
    return "auth";
  if (/tool|mcp|connection/i.test(msg)) return "tool_error";
  if (/model|provider|anthropic|openai|gemini|claude/i.test(msg))
    return "model_error";
  return "unknown";
}

/**
 * Pick the harness id from the resolved credential's provider id.
 *
 * Anything that isn't a recognized CLI agent provider id maps to
 * decopilot — the native in-tree harness. The CLI agent providers each
 * own their own harness (see `apps/mesh/src/harnesses/{claude-code,codex}`).
 *
 * Exported so POST /messages can resolve the harness up-front (before
 * enqueuing onto the thread gate) to decide whether the request needs
 * a link daemon and which capability to check.
 */
export function resolveHarnessId(providerId: string | undefined): HarnessId {
  if (providerId === "claude-code") return "claude-code";
  if (providerId === "codex") return "codex";
  return "decopilot";
}

/**
 * Adapt an AsyncIterable<UIMessageChunk> (the harness output) into a
 * ReadableStream<UIMessageChunk> so it can flow through `writer.merge()`.
 */
function asReadableStream(
  source: AsyncIterable<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  const iter = source[Symbol.asyncIterator]();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      // Best-effort: notify the source so a generator can run its
      // `finally` block (e.g. closing the codex provider subprocess).
      if (typeof iter.return === "function") {
        await iter.return(reason).catch(() => {});
      }
    },
  });
}

/**
 * Find the last coding-agent session id stored on a prior assistant
 * message. Today only claude-code uses this — codex spawns a new process
 * per request, so its threadId can't be resumed. The provider filter
 * guards against picking up a codex threadId when the user switches
 * provider mid-thread.
 */
function lookupResumeSessionRef(
  messages: ChatMessage[],
  harnessId: HarnessId,
): string | undefined {
  if (harnessId !== "claude-code") return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const meta = msg?.metadata as {
      codingAgentSessionId?: string;
      codingAgentProvider?: string;
    };
    if (
      msg?.role === "assistant" &&
      meta?.codingAgentSessionId &&
      meta?.codingAgentProvider === "claude-code"
    ) {
      return meta.codingAgentSessionId;
    }
  }
  return undefined;
}

function modelInfoFromResolvedTier(
  resolved: ResolvedTier,
): ModelsConfig["thinking"] {
  return {
    id: resolved.modelId,
    title: resolved.modelMeta.title ?? resolved.modelId,
    provider: resolved.modelMeta.providerId ?? null,
    capabilities:
      resolved.modelMeta.capabilities &&
      resolved.modelMeta.capabilities.length > 0
        ? {
            vision:
              resolved.modelMeta.capabilities.includes("vision") ||
              resolved.modelMeta.capabilities.includes("image") ||
              undefined,
            text: resolved.modelMeta.capabilities.includes("text") || undefined,
            reasoning:
              resolved.modelMeta.capabilities.includes("reasoning") ||
              undefined,
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

async function resolveDecopilotTitleConfig(
  ctx: StudioContext,
  organizationId: string,
): Promise<{ provider: MeshProvider; model: ModelsConfig["thinking"] } | null> {
  const resolved = await tryResolveTier(ctx, "fast");
  if (!resolved) return null;

  const allowedModels = await fetchModelPermissions(
    ctx.db,
    organizationId,
    ctx.auth.user?.role,
  );
  if (
    allowedModels !== undefined &&
    !checkModelPermission(
      allowedModels,
      resolved.credentialId,
      resolved.modelId,
    )
  ) {
    return null;
  }

  const provider = await ctx.aiProviders
    .activate(resolved.credentialId, organizationId)
    .catch((err) => {
      console.warn("[decopilot:title] failed to activate title provider", err);
      return null;
    });
  if (!provider) return null;

  return { provider, model: modelInfoFromResolvedTier(resolved) };
}

/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a CLI
 * harness will use to talk to mesh's virtual-MCP gateway over HTTP. Only
 * called for harnesses that actually open an HTTP MCP connection
 * (claude-code, codex); decopilot's in-process passthrough doesn't need
 * this.
 *
 * `targetRunsIn` decides which base URL to mint:
 *   - `"cluster"` — `getInternalUrl()` (loopback; the harness runs inside
 *     the cluster pod alongside the API).
 *   - `"user-desktop"` — `getPublicUrl()` (the harness runs on the user's
 *     desktop and dials the cluster back over the public network).
 */
const MCP_KEY_TTL_SECONDS = 3600;

async function mintMcpEndpoint(
  ctx: StudioContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
  targetRunsIn: DispatchTarget["runsIn"],
): Promise<{
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}> {
  const apiKey = await ctx.boundAuth.apiKey.create({
    name: apiKeyName,
    expiresIn: MCP_KEY_TTL_SECONDS,
    metadata: {
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
      },
    },
  });
  const baseUrl =
    targetRunsIn === "user-desktop" ? getPublicUrl() : getInternalUrl();
  return {
    url: `${baseUrl}/mcp/virtual-mcp/${agentId}`,
    headers: {
      Authorization: `Bearer ${apiKey.key}`,
      "x-org-id": organization.id,
    },
    // Wire-shape: HarnessStreamInputWire requires expiresAt for the
    // remote-cli path so the daemon can pre-empt expiry with a refresh
    // (v2 — currently only used for logging / forward-compat).
    expiresAt: Date.now() + MCP_KEY_TTL_SECONDS * 1000,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  id: string;
}

export interface DispatchRunInput {
  messages: ChatMessage[];
  models: ModelsConfig;
  agent: AgentConfig;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  /** Chat mode — plan, forced web search / image, or default */
  mode: ChatMode;
  organizationId: string;
  userId: string;
  taskId?: string;
  triggerId?: string;
  windowSize?: number;
  abortSignal?: AbortSignal;
  isResume?: boolean;
  /** Persisted to the thread row on first-message creation. */
  branch?: string | null;
  /**
   * Pre-resolved dispatch target. Set by POST /messages before enqueuing
   * onto the per-thread gate so the workflow body never has to call
   * `resolveDispatchTarget` itself (avoids replay-time drift if the link
   * goes offline between enqueue and dispatch). Defaults to
   * `{ runsIn: "cluster", sandbox: "cluster" }` when omitted, preserving
   * the pre-Phase-4 behavior.
   */
  target?: DispatchTarget;
  /**
   * Pre-resolved harness id (Decopilot / Claude Code / Codex) from POST
   * /messages — taken from the thread's persisted pin or the request
   * body. When omitted, falls back to deriving from the credential's
   * provider id (legacy behavior; still correct for Decopilot).
   *
   * Necessary because the desktop-CLI harnesses no longer have an
   * `ai_provider_keys` row to drive the credential→harness lookup —
   * their `credentialId` is the sentinel `desktop:<harness>`.
   */
  harnessId?: HarnessId | null;
}

export interface DispatchRunDeps {
  runRegistry: RunRegistry;
  streamBuffer?: StreamBuffer;
  cancelBroadcast: CancelBroadcast;
  /** When provided, the auto-titler emits a `decopilot.thread.status` SSE
   *  event after committing the new title to the DB so tabs not subscribed
   *  to the per-thread `/stream` see the updated title in real-time.
   *  Optional — callers without an sseHub (e.g. the orphan-recovery path)
   *  may omit it; the omission is safe and the auto-title still persists. */
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
}

export interface DispatchRunResult {
  taskId: string;
}

// ============================================================================
// Core Logic
// ============================================================================

function dispatchRunSpanAttrs(input: DispatchRunInput): Record<string, string> {
  return {
    "decopilot.agent.id": input.agent.id,
    "decopilot.model.id": input.models.thinking.id,
    "decopilot.credential.id": input.models.credentialId,
    "decopilot.organization.id": input.organizationId,
    "decopilot.user.id": input.userId,
    "decopilot.thread.id": input.taskId ?? "",
  };
}

/**
 * Drain-to-completion: claim the run, await the run's chunks until the
 * `{done: true}` sentinel arrives, return `{ taskId }`. Used by callers
 * that need to block on the agent's completion (DBOS workflow steps).
 *
 * When `deps.streamBuffer` is configured and the JetStream tail is
 * available, the run pumps into JetStream like a normal HTTP run and this
 * function drains the tail with `closeOnDone: true`. That gives the
 * unification benefit: a queued user message and an automation share the
 * same wire-level path, and any UI tailing the per-thread subject sees
 * automation chunks too.
 *
 * If streamBuffer is unavailable (test mode, NATS down), falls back to
 * reading `uiStream` directly so the function remains usable. The
 * fallback drops chunks (no subscriber sees them) but the run still
 * completes.
 */
export async function dispatchRunAndWait(
  input: DispatchRunInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
): Promise<DispatchRunResult> {
  return traced(
    "decopilot.dispatchRunAndWait",
    async (rootSpan) => {
      const { taskId, uiStream, registrySignal } = await prepareRun(
        input,
        ctx,
        deps,
        rootSpan,
      );

      const buffer = deps.streamBuffer;
      // `deliverPolicy: "new"` here, not "all". The subscription is set
      // up before `pump()` runs, so every chunk for *this* run lands in
      // the "new" window. Replaying "all" could surface a stale
      // `{done:true}` left on the subject by an earlier run that shared
      // the same `taskId` (DBOS crash-recovery replay; later, user
      // messages reusing the per-thread subject) and close the tail
      // before this run produces any output.
      const tail = buffer
        ? await buffer.createTailStream(taskId, input.abortSignal, {
            deliverPolicy: "new",
            closeOnDone: true,
          })
        : null;

      if (buffer && tail) {
        buffer.pump(uiStream, taskId, registrySignal);
        const reader = tail.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // Fallback: no JetStream tail available — drain uiStream directly.
        // Preserves the previous behavior for test environments and any
        // deployment without NATS. No chunks are observable to tailers in
        // this mode.
        const reader = uiStream.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      }

      return { taskId };
    },
    dispatchRunSpanAttrs(input),
  );
}

/**
 * The fully-assembled, JSON-serializable wire shape of a run's harness
 * input — everything `HarnessStreamInput` carries EXCEPT the two
 * non-serializable in-process fields (`signal`, `processLocal`). This is
 * exactly what the desktop daemon validates against
 * `harnessStreamInputSchema` and what the pull-transport work item carries.
 *
 * Built eagerly in `prepareRun`'s main body (mcp mint + message
 * materialization + field assembly) so it's available without consuming
 * `uiStream`. The in-cluster dispatch path layers the in-process extras on
 * top inside the lazy `createUIMessageStream` execute callback:
 * `{ ...wireHarnessInput, signal: registrySignal, processLocal }`.
 */
export type WireHarnessInput = Omit<
  HarnessStreamInput,
  "signal" | "processLocal"
>;

interface PreparedRun {
  taskId: string;
  uiStream: ReadableStream<unknown>;
  registrySignal: AbortSignal;
  /** Minted by prepareRun for pull-transport threads (spec §3.5). */
  runFenceToken: string;
  /**
   * Fully-assembled wire harness input (mcp minted, messages materialized,
   * fence token attached). `dispatchRunAndWait` ignores this (it consumes
   * `uiStream`); `pullDispatch` returns it so the gate can publish it as the
   * pull work item's `harnessInput` (Phase D daemon pull loop consumes it).
   */
  wireHarnessInput: WireHarnessInput;
}

/**
 * Setup phase shared by both dispatch variants. Claims the run, loads
 * conversation history, dispatches through the harness registry, and
 * constructs `uiStream` from the AI SDK pipeline. Returns the stream to
 * whoever called it; the caller decides how to consume it (pump for
 * fan-out, drain for direct await).
 *
 * Setup-phase errors propagate out of here with the run already
 * force-FINISHED to "failed" in the registry. Consumption-phase errors
 * (pump publish failures, drain read failures) are handled by the
 * consumer.
 */
async function prepareRun(
  input: DispatchRunInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
  rootSpan: import("@opentelemetry/api").Span,
): Promise<PreparedRun> {
  const { runRegistry, streamBuffer, sseHub } = deps;

  // Normalize: ensure every message has an id (runtime callers may omit it)
  input = {
    ...input,
    messages: input.messages.map((m) =>
      m.id ? m : { ...m, id: generateMessageId() },
    ),
  };

  let runStarted = false;
  let taskId: string | undefined;

  try {
    const credentialKey = await ctx.storage.aiProviderKeys
      .findById(input.models.credentialId, input.organizationId)
      .catch(() => null);
    // Prefer the pre-resolved pin from POST /messages (covers desktop-CLI
    // harnesses whose synthetic credentialId doesn't match any row);
    // fall back to deriving from the credential's provider id for legacy
    // callers (e.g. older automation paths) that don't set `harnessId`.
    const harnessId: HarnessId =
      input.harnessId ?? resolveHarnessId(credentialKey?.providerId);
    rootSpan.setAttribute("decopilot.harnessId", harnessId);

    // Resolve the dispatch target. POST /messages already runs
    // `resolveDispatchTarget` and forwards the result on `input.target`;
    // we re-read it here (defaulting to a cluster-default target for any
    // caller — e.g. legacy automation paths — that hasn't been migrated
    // yet).
    const target: DispatchTarget = input.target ?? {
      runsIn: "cluster",
      sandbox: "cluster",
    };

    // Stash the resolved target on the context so downstream consumers
    // (the desktop sandbox provider, remote-cli dispatch) can read it
    // without re-querying the registry.
    if (target.runsIn === "cluster") {
      // Cluster harness: either the default cluster sandbox or, when
      // sandbox is "user-desktop", tunnel sandbox tool calls to the user's
      // link daemon.
      ctx.sandboxPreference =
        target.sandbox === "user-desktop" ? "user-desktop" : "cluster-default";
      ctx.linkForCurrentRun = target.link;
    } else {
      // runsIn === "user-desktop": no in-cluster sandbox runs, but we
      // still hold the link reference for the eventual remoteDispatch
      // call below.
      ctx.linkForCurrentRun = target.link;
    }
    rootSpan.setAttribute("decopilot.dispatchTarget.runsIn", target.runsIn);
    rootSpan.setAttribute("decopilot.dispatchTarget.sandbox", target.sandbox);

    // 1. Check model permissions (decopilot-only; CLI harnesses run with
    //    the user's own provider credential / local CLI binary, which is
    //    already vetted at credential-creation time).
    //    Also filters image/deepResearch tier slots: routes.ts already
    //    strips disallowed tiers at HTTP entry, but resume + automation
    //    paths re-enter through dispatch-run without that gate, so this
    //    second pass keeps the policy consistent across entry points.
    if (harnessId === "decopilot") {
      const allowedModels = await fetchModelPermissions(
        ctx.db,
        input.organizationId,
        ctx.auth.user?.role,
      );

      if (
        !checkModelPermission(
          allowedModels,
          input.models.credentialId,
          input.models.thinking.id,
        )
      ) {
        throw new Error("Model not allowed for your role");
      }
      input = {
        ...input,
        models: filterToolTiersByPermission(allowedModels, input.models),
      };
    }

    const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;

    if (!input.taskId) {
      throw new Error("dispatchRunAndWait: taskId is required");
    }

    // 2. Load entities and create/load memory in parallel.
    // Activate per-tool providers when their tier resolves to a different
    // credential than the chat tier (image, deep research). Skip the extra
    // activation when the credential matches — the chat provider is reused.
    const chatCredId = input.models.credentialId;
    const imageCredId = input.models.image?.credentialId;
    const deepResearchCredId = input.models.deepResearch?.credentialId;
    const needsImageProvider =
      harnessId === "decopilot" && !!imageCredId && imageCredId !== chatCredId;
    const needsDeepResearchProvider =
      harnessId === "decopilot" &&
      !!deepResearchCredId &&
      deepResearchCredId !== chatCredId;

    const [virtualMcp, provider, imageProvider, deepResearchProvider, mem] =
      await Promise.all([
        ctx.storage.virtualMcps.findById(input.agent.id, input.organizationId),
        harnessId === "decopilot"
          ? ctx.aiProviders.activate(chatCredId, input.organizationId)
          : Promise.resolve(null),
        needsImageProvider
          ? ctx.aiProviders.activate(imageCredId, input.organizationId)
          : Promise.resolve(null),
        needsDeepResearchProvider
          ? ctx.aiProviders.activate(deepResearchCredId, input.organizationId)
          : Promise.resolve(null),
        createMemory(ctx.storage.threads, {
          organization_id: input.organizationId,
          thread_id: input.taskId,
          userId: input.userId,
          defaultWindowSize: windowSize,
        }),
      ]);

    const decopilotTitleConfig =
      harnessId === "decopilot"
        ? await resolveDecopilotTitleConfig(ctx, input.organizationId)
        : null;

    // Diagnostic (resume only): record whether the provider activated and
    // whether the optional model slots are present. Paired with the log in
    // routes.ts:/attach orphan-resume; together they pinpoint whether tool
    // dropout on resume is a persistence-side or provider-activation issue.
    // Drop once the resume-tool-dropout issue is root-caused.
    if (input.isResume) {
      console.log("[decopilot:stream] resume — runtime state", {
        taskId: input.taskId,
        harnessId,
        providerActivated: !!provider,
        imageProviderActivated: !!imageProvider,
        deepResearchProviderActivated: !!deepResearchProvider,
        thinkingModelId: input.models.thinking.id,
        hasImage: !!input.models.image,
        hasDeepResearch: !!input.models.deepResearch,
      });
    }

    taskId = mem.thread.id;
    ctx.metadata.threadId = mem.thread.id;
    rootSpan.setAttribute("decopilot.thread.id", mem.thread.id);

    if (mem.thread.created_by !== input.userId) {
      throw new Error(
        "You are not allowed to write to this thread because you are not the owner",
      );
    }

    // Guard: async-research-only models (e.g. Gemini Deep Research) cannot
    // drive `streamText`. They only work via the AsyncResearchProvider path
    // routed through the `web_search` tool. Detect early and surface a clear
    // error instead of letting Google's opaque "This model only supports
    // Interactions API" bubble up from deep inside the agent loop.
    if (provider?.asyncResearch) {
      const slots: Array<["thinking" | "coding" | "fast" | "image", string]> = [
        ["thinking", input.models.thinking.id],
      ];
      if (input.models.coding) slots.push(["coding", input.models.coding.id]);
      if (input.models.fast) slots.push(["fast", input.models.fast.id]);
      if (input.models.image) slots.push(["image", input.models.image.id]);
      for (const [slot, modelId] of slots) {
        if (provider.asyncResearch.canHandle(modelId)) {
          throw new Error(
            `Model "${modelId}" can only be used as a Deep Research model. ` +
              `It is not usable as the ${slot} model — set it in the Deep Research slot instead.`,
          );
        }
      }
    }

    const saveMessagesToThread = async (
      ...messages: (ChatMessage | undefined)[]
    ) => {
      const now = Date.now();
      const messagesToSave = [
        ...new Map(messages.filter(Boolean).map((m) => [m!.id, m!])).values(),
      ]
        .filter((m) => m.parts && m.parts.length > 0)
        .map((message, i) => ({
          ...message,
          thread_id: mem.thread.id,
          created_at: new Date(now + i).toISOString(),
          updated_at: new Date(now + i).toISOString(),
        }));
      if (messagesToSave.length === 0) return;
      await mem.save(messagesToSave as ThreadMessage[]).catch((error) => {
        console.error("[decopilot:stream] Error saving messages", error);
      });
    };

    // ── Stream-of-record v2 write path (canary-gated; OFF by default) ───────
    // `isV2` is read straight off the thread row's pinned
    // `message_storage_version`. When 1 (the default for every existing
    // thread), `partEmitter` is null and the v1 `saveMessagesToThread` path
    // below runs byte-for-byte unchanged. When 2 (only ever set on a
    // brand-new thread by the canary at the first-message pin site in
    // routes.ts), parts are emitted via the PartEmitter at the same hooks
    // INSTEAD of `saveMessagesToThread`. The two paths are mutually exclusive
    // — no thread is ever written through both.
    const isV2 = mem.thread.message_storage_version === 2;
    const partEmitter = isV2
      ? new PartEmitter({
          storage: ctx.storage.threads.messageParts(),
          orgId: input.organizationId,
          threadId: mem.thread.id,
          // RunRegistry keys runs by taskId; the thread id is the run id.
          runId: mem.thread.id,
        })
      : null;

    if (!virtualMcp) {
      throw new Error("Agent not found");
    }

    // 3. Dispatch START or RESUME
    if (input.isResume) {
      await runRegistry.execute({
        type: "RESUME",
        taskId: mem.thread.id,
        orgId: input.organizationId,
        userId: input.userId,
        abortController: new AbortController(),
        podId: getPodId(),
      });
    } else {
      await runRegistry.execute({
        type: "START",
        taskId: mem.thread.id,
        orgId: input.organizationId,
        userId: input.userId,
        abortController: new AbortController(),
        podId: getPodId(),
        runConfig: {
          models: input.models,
          agent: input.agent,
          temperature: input.temperature,
          toolApprovalLevel: input.toolApprovalLevel,
          mode: input.mode,
          windowSize: input.windowSize,
          triggerId: input.triggerId,
        },
      });
    }
    runStarted = true;

    // Mint the single-writer fence token for this run. The token is
    // included in HarnessStreamInput so the daemon presents it on every
    // ingest append. Minting after START ensures the run is claimed before
    // the token exists; clearing on FINISH is the gate's responsibility.
    // On DBOS replay this re-mints a new token while a queued work item carries the old one —
    // reconcile when Phase D wires the publish off the persisted column.
    // Note: a failed pull run leaves run_fence_token set until Task 7 clears it
    // (harmless: next run overwrites; ws/cloud never read it).
    const runFenceToken = crypto.randomUUID();
    await ctx.storage.threads.setRunFence(mem.thread.id, runFenceToken);

    const registrySignal = runRegistry.getAbortSignal(mem.thread.id);
    if (!registrySignal) {
      await runRegistry.execute({
        type: "FINISH",
        taskId: mem.thread.id,
        threadStatus: "failed",
      });
      throw new Error("Run was cancelled immediately after starting");
    }

    // If an external abort signal is provided (e.g. from automation runner),
    // forward it to the registry's abort controller so the run is cancelled.
    if (input.abortSignal) {
      const externalSignal = input.abortSignal;
      if (externalSignal.aborted) {
        await runRegistry.execute({
          type: "CANCEL",
          taskId: mem.thread.id,
        });
      } else {
        externalSignal.addEventListener(
          "abort",
          () => {
            runRegistry
              .execute({ type: "CANCEL", taskId: mem.thread.id })
              .catch(() => {});
          },
          { once: true },
        );
      }
    }

    // Purge stale buffered chunks from any previous run on this thread
    streamBuffer?.purge(mem.thread.id);

    // Split system messages from user message
    const systemMessages = input.messages.filter((m) => m.role === "system");
    const requestMessage = input.messages.find((m) => m.role !== "system");

    // Upload file parts before saving so the thread stores stable
    // mesh-storage: URIs instead of base64 data: blobs.
    const materializedRequestMessage = requestMessage
      ? ((await uploadFileParts([requestMessage], ctx)).find(
          (m) => m.role !== "system",
        ) as typeof requestMessage)
      : undefined;

    if (!input.isResume) {
      if (!materializedRequestMessage) {
        throw new Error(
          "No user message found in input — expected at least one non-system message",
        );
      }
      if (partEmitter) {
        // v2: persist the user message's parts + a finish anchor so the
        // message is immediately complete in the parts read path.
        await partEmitter
          .emitUserMessage(materializedRequestMessage)
          .catch((error) => {
            console.error(
              "[decopilot:stream] v2 user-message emit failed",
              error,
            );
          });
      } else {
        await saveMessagesToThread(materializedRequestMessage);
      }
    }

    let streamFinished = false;
    const pendingOps: Promise<void>[] = [];
    // Reference assigned inside `execute` once the writer is available;
    // `onStepFinish` (a sibling callback to `execute`) closes over this
    // variable and reads it after the first step has been dispatched.
    let htmlPageBufferRef: ReturnType<typeof createHtmlPageBuffer> | null =
      null;

    // Pre-load conversation (no system messages — those are built separately)
    // When resuming, requestMessage is undefined — conversation loads entirely
    // from DB via createMemory / loadAndMergeMessages.
    const allMessages = await loadAndMergeMessages(
      mem,
      materializedRequestMessage,
      systemMessages,
      windowSize,
    );

    const resumeSessionRef = lookupResumeSessionRef(allMessages, harnessId);

    const organization = ctx.organization!;
    const streamStartAt = Date.now();
    let aggregatedUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // ── Build the wire HarnessStreamInput EAGERLY ───────────────────────────
    // Everything the daemon's `harnessStreamInputSchema` needs (mcp endpoint,
    // materialized messages, virtualMcp, fence token, …) is assembled here,
    // before the lazy stream-execute callback runs. Two consumers read it:
    //   - in-cluster dispatch (the `execute` callback below) layers the
    //     non-serializable in-process extras on top:
    //     `{ ...wireHarnessInput, signal: registrySignal, processLocal }`.
    //   - `pullDispatch` returns it verbatim so the thread gate can publish
    //     it as the pull work item's `harnessInput` (Phase D daemon loop).
    // Moving the mcp mint + message materialization out of `execute` means
    // they now run slightly earlier (eagerly) for the in-cluster path too —
    // acceptable per the hard-break; behavior is otherwise identical.

    // Resolve mesh-storage: URIs to fresh presigned URLs every turn.
    // Also handles legacy data: URLs from threads predating this pipeline.
    // `processConversation` (which depends on the harness-owned tool set for
    // `toModelOutput` handlers) runs inside the decopilot harness itself; we
    // forward materialized UIMessages so each harness decides how to convert
    // them.
    const materializedMessages = await resolveStorageRefs(allMessages, ctx);

    ensureModelCompatibility(input.models, materializedMessages);

    // Build the MCP endpoint for CLI harnesses. In-cluster decopilot uses an
    // in-process passthrough client (no HTTP MCP connection needed), so we
    // use a sentinel for that path. Desktop decopilot requires a real endpoint
    // so the daemon can reach cluster-side MCP tools.
    const mcpBase =
      harnessId === "decopilot" && target.runsIn !== "user-desktop"
        ? {
            url: "",
            headers: {} as Record<string, string>,
            // Sentinel for the in-process decopilot path — its passthrough
            // client doesn't consume mcp.* but the shared HarnessStreamInput
            // type requires the field.
            expiresAt: 0,
          }
        : await mintMcpEndpoint(
            ctx,
            input.agent.id,
            organization,
            harnessId === "claude-code"
              ? "claude-code-session"
              : harnessId === "decopilot"
                ? "decopilot-session"
                : "codex-session",
            target.runsIn,
          );

    // ⚠️ SECURITY: Inject the main chat-model API key into the wire input for
    // user-desktop decopilot. The key transits to the desktop daemon over HTTPS
    // so it can activate the MeshProvider locally without vault access.
    // Scoped to the single main chat-completion credential only — sub-provider
    // keys (image, deep-research) are never included; those built-ins stay
    // cluster-side. Hardening follow-up: cluster model-proxy (spec §3.9).
    //
    // DORMANT: decopilot is not yet routed to user-desktop (it is absent from
    // the daemon registry and resolveDispatchTarget never produces
    // runsIn === "user-desktop" for decopilot). This condition is never true
    // today — it is wired now so the wire contract exists before the daemon
    // factory is registered in a later task.
    let modelSecret: HarnessStreamInput["mcp"]["modelSecret"];
    if (target.runsIn === "user-desktop" && harnessId === "decopilot") {
      // Read the raw credential from storage (vault-backed) — the same path
      // AIProviderFactory.activate() uses internally. Never log this variable.
      const resolved = await ctx.storage.aiProviderKeys
        .resolve(chatCredId, input.organizationId)
        .catch(() => null);
      if (resolved) {
        const { keyInfo, apiKey } = resolved;
        // openai-compatible stores a JSON blob { baseUrl, apiKey }; unpack it.
        if (keyInfo.providerId === "openai-compatible") {
          try {
            const parsed = JSON.parse(apiKey) as {
              baseUrl?: string;
              apiKey?: string;
            };
            modelSecret = {
              providerId: keyInfo.providerId,
              apiKey: parsed.apiKey ?? "",
              ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
            };
          } catch {
            modelSecret = { providerId: keyInfo.providerId, apiKey };
          }
        } else {
          modelSecret = { providerId: keyInfo.providerId, apiKey };
        }
      }
    }

    const mcp: HarnessStreamInput["mcp"] = modelSecret
      ? { ...mcpBase, modelSecret }
      : mcpBase;

    const wireHarnessInput: WireHarnessInput = {
      threadId: mem.thread.id,
      runId: mem.thread.id, // RunRegistry keys runs by taskId today
      resumeSessionRef,
      messages: materializedMessages,
      models: input.models,
      mcp,
      mode: input.mode,
      temperature: input.temperature,
      toolApprovalLevel: input.toolApprovalLevel,
      user: { id: input.userId, email: ctx.auth.user?.email ?? "" },
      organizationId: input.organizationId,
      projectSlug: organization.slug,
      virtualMcp,
      agent: { id: input.agent.id },
      branch: input.branch,
      taskId: input.taskId,
      triggerId: input.triggerId,
      currentThreadTitle: mem.thread.title,
      runFenceToken,
    };

    const uiStream = createUIMessageStream({
      originalMessages: allMessages,
      execute: async ({ writer }) => {
        // The wire input (mcp endpoint + materialized messages + all
        // serializable fields) was already assembled eagerly above. Here we
        // only build the non-serializable in-process extras that decopilot
        // needs to participate in the surrounding `createUIMessageStream`
        // scope. CLI harnesses ignore this field.
        const toolOutputMap = new Map<string, string>();
        const pendingImages: PendingImage[] = [];
        // Per-turn buffer for coalesced HTML-page mirrors. The VM `write`/
        // `edit` tools enqueue here; `onStepFinish` below schedules a
        // single `flush()` per step (pushed to `pendingOps`, awaited at
        // `onFinish` before the stream closes). Assigned to the
        // outer-scope `htmlPageBufferRef` so `onStepFinish` can see it.
        const htmlPageBuffer = createHtmlPageBuffer(ctx, writer);
        htmlPageBufferRef = htmlPageBuffer;
        const processLocal: HarnessProcessLocal = {
          writer,
          toolOutputMap,
          pendingImages,
          threadId: mem.thread.id,
          currentThreadTitle: mem.thread.title,
          registrySignal,
          runRegistry,
          provider,
          imageProvider: imageProvider ?? provider,
          deepResearchProvider: deepResearchProvider ?? provider,
          titleProvider: decopilotTitleConfig?.provider ?? provider,
          titleModel:
            decopilotTitleConfig?.model ??
            input.models.fast ??
            input.models.thinking,
          htmlPageBuffer,
          registerPendingOp: (op) => {
            pendingOps.push(op);
          },
          isStreamFinished: () => streamFinished,
          onUsageAggregated: (totalUsage) => {
            aggregatedUsage = {
              inputTokens: aggregatedUsage.inputTokens + totalUsage.inputTokens,
              outputTokens:
                aggregatedUsage.outputTokens + totalUsage.outputTokens,
              totalTokens: aggregatedUsage.totalTokens + totalUsage.totalTokens,
            };
          },
          onTitleUpdated: sseHub
            ? buildOnTitleUpdated({
                ctx,
                sseHub,
                threadId: mem.thread.id,
                organizationId: input.organizationId,
              })
            : undefined,
        };

        // Layer the in-process extras onto the eagerly-built wire input.
        // `signal` and `processLocal` are the only non-serializable members;
        // everything else (mcp, materialized messages, fence token, …) was
        // assembled above and is shared verbatim with the pull work item.
        const harnessInput: HarnessStreamInput = {
          ...wireHarnessInput,
          signal: registrySignal,
          processLocal,
        };

        // claude-code cwd resolution: with the `host` runner gone, the
        // cluster never has a local on-disk workdir to point the CLI at,
        // so the harness falls back to its own ambient cwd. Remote-user
        // dispatch runs the harness inside the desktop daemon, where the
        // daemon is spawned with workdir = sandbox path; remote-cli runs
        // claude-code in-process on the user's machine (no resolver
        // needed). The cluster (agent-sandbox) runner doesn't surface a
        // local FS to mesh.

        // Dispatch through the registry. The harness produces a stream
        // of UIMessageChunk; we adapt it to a ReadableStream so it can
        // flow through writer.merge(). When a streamBuffer is wired, its
        // JetStream pump reads the merged uiStream output and publishes
        // every chunk into the per-task subject — that's what /stream
        // tails. We do NOT pipe through the buffer here; the pump is
        // detached and consumes uiStream directly after prepareRun
        // returns.
        //
        // Branch on the resolved target:
        //   - `runsIn === "user-desktop"` — the whole stream is delegated
        //     to the user's link daemon. `resolveRemoteCliSandboxUrl`
        //     calls `ensureSandbox` (handle == `computeHandle(sandboxId,
        //     branch)`) so the sandbox is the same one SANDBOX_START
        //     provisions — repo cloned, env pushed, dev server primed.
        //     The cluster talks to the daemon over the NATS-backed dispatch
        //     channel. Per-run state inside the daemon stays keyed by
        //     `runId` (cancellation via DELETE /_sandbox/runs/<runId>).
        //   - `runsIn === "cluster"` — runs in-cluster. When `sandbox`
        //     is `"user-desktop"` the sandbox tool calls are forwarded
        //     to the user's link daemon; the harness still runs here.
        let rawHarnessChunks;
        if (target.runsIn === "user-desktop") {
          // Pure handle derivation — no ensure round-trip. The daemon self-ensures
          // the sandbox from `WorkItem.sandbox` when it dequeues the item
          // (cluster-connection-pull.ts:214: `input.provider.ensureSandbox(ensureInput)`),
          // so the warm-ensure that `resolveRemoteCliSandboxHandle` performed here
          // is redundant on the pull path (C-bis S4). The handle formula is
          // identical to what `ensureSandbox`/`provisionSandbox` would compute:
          // composeSandboxRef → computeClaimHandle. See `computeDesktopSandboxHandle`.
          const effectiveBranch =
            mem.thread.branch ?? input.branch ?? "ephemeral";
          const sandboxHandle = computeDesktopSandboxHandle({
            agentId: input.agent.id,
            userId: input.userId,
            organizationId: input.organizationId,
            branch: effectiveBranch,
          });
          // Route through the unified `proxyDaemonRequest` seam: the desktop
          // provider tunnels `/dispatch` over the same WS+NATS link transport
          // the old raw `dispatch` dep used, but now consumes the returned
          // streaming `Response` (DispatchFn is a private impl detail of the
          // provider). `proxyDaemonRequest` expects a `ProxyRequestInit`
          // (`headers: Headers`, `body: BodyInit | null`), so adapt our
          // simpler `{ headers: Record<string,string>, body: string }` shape.
          const provider = await buildDesktopProvider(ctx, input.userId);
          // Body-offload: when the dispatch body exceeds the per-message
          // budget, `remoteDispatch` writes `input.messages` to object
          // storage and the daemon re-inflates from the ref. `supported`
          // mirrors the daemon's advertised capability (from the link claim
          // resolved on `target.link`); without object storage the seam is a
          // hard "no" so an oversized body fails loudly rather than silently
          // truncating.
          const supported =
            target.link?.capabilities?.includes("body-offload") ?? false;
          const offload = ctx.objectStorage
            ? {
                supported,
                put: async (reqId: string, messagesJson: string) => {
                  const bytes = new TextEncoder().encode(messagesJson);
                  const key = offloadKey(reqId);
                  await ctx.objectStorage!.put(key, bytes, {
                    contentType: "application/json",
                  });
                  const url = await ctx.objectStorage!.presignedGetUrl(
                    key,
                    600,
                    { requireFetchable: true },
                  );
                  return {
                    url,
                    bytes: bytes.byteLength,
                    sha256: await sha256Hex(bytes),
                  };
                },
                cleanup: (key: string) =>
                  ctx.objectStorage!.delete(key).then(() => {}),
              }
            : {
                supported: false,
                put: async () => {
                  throw new Error("no object storage");
                },
                cleanup: async () => {},
              };
          rawHarnessChunks = remoteDispatch(
            harnessId,
            harnessInput,
            sandboxHandle,
            {
              proxyDaemonRequest: (h, p, init) =>
                provider.proxyDaemonRequest(h, p, {
                  method: init.method,
                  headers: new Headers(init.headers),
                  body: init.body ?? null,
                  signal: init.signal,
                }),
              offload,
            },
          );
        } else {
          rawHarnessChunks = localDispatch(harnessId, harnessInput, ctx);
        }

        // Tap harness-generated title result chunks so the cluster can keep
        // persistence/SSE ownership while each harness owns title generation.
        const harnessChunks = interceptTitleChunks(rawHarnessChunks, {
          ctx,
          processLocal,
          currentThreadTitle: mem.thread.title,
          threadId: mem.thread.id,
          writer,
          onTitleUpdated: processLocal.onTitleUpdated,
        });
        const harnessStream = asReadableStream(harnessChunks);

        // Cast: the outer createUIMessageStream is typed via ChatMessage so
        // writer.merge expects ChatMessage-shaped chunks, but the harness
        // emits the structurally-equivalent generic UIMessageChunk shape.
        writer.merge(harnessStream as Parameters<typeof writer.merge>[0]);
      },
      onFinish: async ({ responseMessage, finishReason }) => {
        console.log(
          "[decopilot:title-debug] onFinish called, setting streamFinished=true threadId=%s pendingOps=%d",
          mem.thread.id,
          pendingOps.length,
        );
        streamFinished = true;

        await Promise.allSettled(pendingOps);
        if (partEmitter) {
          // v2: persist any remaining final parts + close the assistant
          // message with a finish anchor.
          await partEmitter.emitFinal(responseMessage).catch((error) => {
            console.error("[decopilot:stream] v2 onFinish emit failed", error);
          });
        } else {
          await saveMessagesToThread(responseMessage);
        }

        if (registrySignal.aborted) return;

        const threadStatus = resolveThreadStatus(
          finishReason,
          responseMessage?.parts as {
            type: string;
            state?: string;
            text?: string;
          }[],
        );

        await runRegistry.execute({
          type: "FINISH",
          taskId: mem.thread.id,
          threadStatus,
        });

        posthog.capture({
          distinctId: input.userId,
          event: "chat_message_completed",
          groups: { organization: input.organizationId },
          properties: {
            organization_id: input.organizationId,
            thread_id: mem.thread.id,
            agent_id: input.agent.id,
            model_id: input.models.thinking.id,
            model_title: input.models.thinking.title,
            mode: input.mode,
            duration_ms: Date.now() - streamStartAt,
            finish_reason: finishReason,
            thread_status: threadStatus,
            input_tokens: aggregatedUsage.inputTokens,
            output_tokens: aggregatedUsage.outputTokens,
            total_tokens: aggregatedUsage.totalTokens,
            is_resume: input.isResume ?? false,
          },
        });
      },
      onStepFinish: ({ responseMessage }) => {
        const transitions = runRegistry.dispatch({
          type: "STEP_DONE",
          taskId: mem.thread.id,
        });
        pendingOps.push(
          runRegistry.react(transitions).catch((e) => {
            console.error("[decopilot:stream] onStepFinish reactor failed", e);
          }),
        );
        // Flush coalesced `pages/<slug>.html` mirrors once per step. The
        // promise is awaited at `onFinish` (Promise.allSettled(pendingOps)
        // a few lines above), so the stream stays open until every PUT
        // lands and the `data-html-page-published` UI signals fire. The
        // ref is null until `execute` constructs the buffer — onStepFinish
        // can fire before then in unusual edge cases (e.g. a malformed
        // chunk surfacing as a finished step before execute runs).
        if (htmlPageBufferRef) {
          pendingOps.push(
            htmlPageBufferRef.flush().catch((e: unknown) => {
              console.error(
                "[decopilot:stream] onStepFinish html-page flush failed",
                e,
              );
            }),
          );
        }
        if (partEmitter) {
          // v2: a finished step's parts are FINAL — persist any newly-final
          // parts every step (the durable incremental write). No finish
          // anchor yet; the assistant message may continue in later steps.
          pendingOps.push(
            partEmitter.emitStepParts(responseMessage).catch((e) => {
              console.error(
                "[decopilot:stream] v2 onStepFinish emit failed",
                e,
              );
            }),
          );
        } else {
          // v1 (unchanged): coarse whole-message checkpoints — every step on
          // resume, every 5th step otherwise.
          const stepEvent = transitions[0]?.event;
          const shouldSave = input.isResume
            ? stepEvent?.type === "STEP_COMPLETED"
            : stepEvent?.type === "STEP_COMPLETED" &&
              stepEvent.stepCount % 5 === 0;
          if (shouldSave) {
            pendingOps.push(
              saveMessagesToThread(responseMessage).catch((e) => {
                console.error("[decopilot:stream] onStepFinish save failed", e);
              }),
            );
          }
        }
      },
      onError: (error) => {
        streamFinished = true;
        if (registrySignal.aborted) {
          // User cancelled (frontend stop button), tab closed mid-stream, or
          // run was force-failed. Frontend chat_message_stopped covers the
          // first case; this server event also covers the other two.
          posthog.capture({
            distinctId: input.userId,
            event: "chat_message_aborted",
            groups: { organization: input.organizationId },
            properties: {
              organization_id: input.organizationId,
              thread_id: mem.thread.id,
              agent_id: input.agent.id,
              model_id: input.models.thinking.id,
              mode: input.mode,
              duration_ms: Date.now() - streamStartAt,
              is_resume: input.isResume ?? false,
            },
          });
          return sanitizeStreamError(error);
        }
        console.error("[decopilot] stream error:", error);
        const sanitized = sanitizeStreamError(error);
        posthog.capture({
          distinctId: input.userId,
          event: "chat_message_failed",
          groups: { organization: input.organizationId },
          properties: {
            organization_id: input.organizationId,
            thread_id: mem.thread.id,
            agent_id: input.agent.id,
            model_id: input.models.thinking.id,
            mode: input.mode,
            duration_ms: Date.now() - streamStartAt,
            error_category: classifyStreamError(error),
            error_message:
              error instanceof Error ? error.message : stringifyError(error),
            is_resume: input.isResume ?? false,
          },
        });

        // Persist the error as a synthetic assistant message so the thread
        // doesn't render a confusing "No response was generated" — the UI
        // pairs user/assistant by created_at and drops orphan assistants.
        // Particularly important for background runs (cron/webhook/event
        // automations) where the user has no console to read the error from.
        if (partEmitter) {
          // v2: emit an `error` part + finish anchor for a fresh assistant
          // message id.
          partEmitter.emitError(generateMessageId(), sanitized).catch((e) => {
            console.error("[decopilot:stream] v2 error emit failed", e);
          });
        } else {
          saveMessagesToThread({
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text: `Error: ${sanitized}` }],
            metadata: { errorCategory: classifyStreamError(error) },
          } as ChatMessage).catch((e) => {
            console.error("[decopilot:stream] error-message save failed", e);
          });
        }

        runRegistry
          .execute({
            type: "FINISH",
            taskId: mem.thread.id,
            threadStatus: "failed",
          })
          .catch((e) => {
            console.error("[decopilot:stream] onError reactor failed", e);
          });

        return sanitized;
      },
    });

    // Setup complete — hand the uiStream back to `dispatchRunAndWait`,
    // which drains it with a reader loop and resolves when the run
    // finishes. When a streamBuffer is configured the run also pumps into
    // JetStream so `/stream` tails see chunks live across runs and tabs.
    //
    // Wrap the stream with a throttled progress tap (Task 9): every chunk
    // that flows out is "progress", collapsed to ≤1 `last_progress_at` write
    // per ~3s per run. The single consumer downstream (pump or direct drain)
    // pulls through this tap, so the heartbeat fires regardless of which
    // consumption path runs.
    return {
      taskId: mem.thread.id,
      uiStream: tapProgress(uiStream, ctx, mem.thread.id),
      registrySignal,
      runFenceToken,
      wireHarnessInput,
    };
  } catch (err) {
    if (runStarted && taskId) {
      runRegistry
        .execute({
          type: "FINISH",
          taskId,
          threadStatus: "failed",
        })
        .catch((e) => {
          console.error("[decopilot:stream] catch-block reactor failed", e);
        });
    }

    throw err;
  }
}

/**
 * Resolve the sandbox provisioning config for a pull-transport work item.
 *
 * Mirrors the logic in `provisionSandbox` but returns the resolved config
 * instead of calling `runner.ensure`. Called from `pullDispatch` for CLI
 * harnesses (claude-code, codex) targeting user-desktop so the daemon can
 * spawn the sandbox cold without a prior WS-path ensure call.
 *
 * Returns `null` when no sandbox config can be derived (e.g. decopilot
 * harness, non-user-desktop target, or unresolvable metadata).
 */
async function resolvePullSandboxConfig(
  input: DispatchRunInput,
  ctx: StudioContext,
  sandboxHandle: string,
): Promise<WorkItemSandbox | null> {
  const harnessId: HarnessId = input.harnessId ?? resolveHarnessId(undefined); // default fallback
  if (harnessId === "decopilot") return null;
  if (!input.target || input.target.runsIn !== "user-desktop") return null;

  const virtualMcp = await ctx.storage.virtualMcps
    .findById(input.agent.id, input.organizationId)
    .catch(() => null);
  if (!virtualMcp) return null;

  const metadata = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const githubRepo =
    (
      metadata as {
        githubRepo?: {
          owner: string;
          name: string;
          connectionId?: string;
        } | null;
      }
    ).githubRepo ?? null;

  // Resolve the clone URL cluster-side so the daemon has it without vault access.
  let repo: WorkItemSandbox["repo"];
  if (githubRepo) {
    try {
      const { cloneUrl, gitUserName, gitUserEmail } = githubRepo.connectionId
        ? await buildCloneInfo(
            githubRepo.connectionId,
            githubRepo.owner,
            githubRepo.name,
            ctx.db,
            ctx.vault,
          )
        : buildAnonymousCloneInfo(githubRepo.owner, githubRepo.name);
      repo = {
        cloneUrl,
        branch: input.branch ?? undefined,
        userName: gitUserName,
        userEmail: gitUserEmail,
      };
    } catch (err) {
      // Log but don't fail the dispatch — the daemon may have a running sandbox.
      console.warn(
        `[pullDispatch] failed to resolve clone info for agent=${input.agent.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Resolve workload from metadata.runtime (same logic as provisionSandbox).
  const { runtime, packageManager, packageManagerPath } =
    resolveRuntimeConfig(metadata);
  let workload: WorkItemSandbox["workload"];
  if (
    runtime &&
    packageManager &&
    (runtime === "node" || runtime === "bun" || runtime === "deno") &&
    (packageManager === "npm" ||
      packageManager === "pnpm" ||
      packageManager === "yarn" ||
      packageManager === "bun" ||
      packageManager === "deno")
  ) {
    workload = {
      runtime,
      packageManager,
      ...(packageManagerPath ? { packageManagerPath } : {}),
    };
  }

  // Derive the message-offload SSRF allowlist from the cluster's own S3 config.
  let offloadAllowedHosts: string[] | undefined;
  let offloadAllowSameHostDev: boolean | undefined;
  try {
    if (ctx.objectStorage) {
      const offload = await deriveOffloadAllowlist(ctx.objectStorage, {
        isProduction: getSettings().nodeEnv === "production",
      });
      offloadAllowedHosts = offload.hosts;
      offloadAllowSameHostDev = offload.allowSameHostDev;
    }
  } catch (err) {
    console.warn(
      `[pullDispatch] failed to derive offload allowlist for agent=${input.agent.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    handle: sandboxHandle,
    ...(repo ? { repo } : {}),
    ...(workload ? { workload } : {}),
    ...(offloadAllowedHosts !== undefined ? { offloadAllowedHosts } : {}),
    ...(offloadAllowSameHostDev !== undefined
      ? { offloadAllowSameHostDev }
      : {}),
  };
}

/**
 * Pull-transport variant of `dispatchRunAndWait` (Phase B, spec §3.4).
 *
 * Claims the run and mints the fence (via prepareRun), then returns the
 * fence token, task id, AND the fully-assembled wire `HarnessStreamInput`
 * for the gate step to thread into the work item published to the JetStream
 * WorkQueue.
 *
 * IMPORTANT: `uiStream` from prepareRun is never consumed here — the
 * local harness does NOT run for pull-transport threads (the daemon runs
 * remotely). The uiStream will be garbage-collected naturally; the run
 * transitions to terminal when the ingest finish handler fires FINISH.
 *
 * The work item's `harnessInput` is the complete `wireHarnessInput` that
 * prepareRun now builds eagerly (mcp endpoint minted, messages
 * materialized, virtualMcp + fence token attached) — exactly the shape the
 * daemon validates against `harnessStreamInputSchema`. The non-serializable
 * `signal`/`processLocal` members are intentionally absent (they only exist
 * for the in-cluster dispatch path). This closes the prior work-item gap;
 * the item is consumed by the Phase D daemon pull loop.
 *
 * Also resolves the sandbox provisioning config (handle, repo clone URL,
 * workload runtime) for CLI harnesses targeting user-desktop, so the daemon
 * can spawn the sandbox cold without a prior WS-path ensure. Carries
 * `orgSlug` so the daemon ingest path can construct the URL without a DB
 * lookup.
 */
export async function pullDispatch(
  input: DispatchRunInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
): Promise<{
  taskId: string;
  runFenceToken: string;
  harnessInput: WireHarnessInput;
  messagesRef: MessagesRef | null;
  sandboxConfig: WorkItemSandbox | null;
  orgSlug: string | null;
}> {
  return traced(
    "decopilot.pullDispatch",
    async (_rootSpan) => {
      const { taskId, runFenceToken, wireHarnessInput } = await prepareRun(
        input,
        ctx,
        deps,
        _rootSpan,
      );

      // ── Message offload (mirrors the WS path in remoteDispatch) ─────────
      // The work item is published to the JetStream WorkQueue as a NATS
      // message; NATS rejects payloads exceeding MAX_PUBLISH_BYTES. The
      // conversation `messages` array is the dominant large part — when the
      // encoded harnessInput exceeds the budget, offload it to object storage
      // exactly as `remoteDispatch` does, then carry the ref on the work item
      // so the daemon can forward it to the sandbox daemon's /_sandbox/dispatch
      // (which already re-inflates from messagesRef on the WS path).
      let effectiveHarnessInput: WireHarnessInput = wireHarnessInput;
      let messagesRef: MessagesRef | null = null;
      const encodedInput = JSON.stringify(wireHarnessInput);
      if (shouldOffload(Buffer.byteLength(encodedInput, "utf8"))) {
        if (ctx.objectStorage) {
          try {
            const reqId = crypto.randomUUID();
            const messagesJson = JSON.stringify(wireHarnessInput.messages);
            const bytes = new TextEncoder().encode(messagesJson);
            const key = offloadKey(reqId);
            await ctx.objectStorage.put(key, bytes, {
              contentType: "application/json",
            });
            const url = await ctx.objectStorage.presignedGetUrl(key, 600, {
              requireFetchable: true,
            });
            messagesRef = {
              url,
              bytes: bytes.byteLength,
              sha256: await sha256Hex(bytes),
            };
            // Replace messages inline with [] — the real messages live at the ref.
            effectiveHarnessInput = { ...wireHarnessInput, messages: [] };
            console.log(
              `[pullDispatch] offloaded messages to object storage key=${key} bytes=${bytes.byteLength} runId=${taskId}`,
            );
          } catch (err) {
            // Offload failed — fall through with the full payload and let
            // NATS reject it with MAX_PAYLOAD_EXCEEDED rather than silently
            // dropping the ref. The publish will throw and the gate will
            // surface the error.
            console.error(
              `[pullDispatch] message offload failed, work item may exceed NATS limit runId=${taskId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        } else {
          // No object storage — fall through with the full payload. Same
          // "fail loudly at publish time" approach: better a clear NATS
          // MAX_PAYLOAD_EXCEEDED than a silent truncation.
          console.warn(
            `[pullDispatch] harnessInput exceeds NATS limit but no object storage configured — work item may be rejected runId=${taskId}`,
          );
        }
      }

      // Resolve the sandbox handle for the pull work item.
      // Pure derivation — no ensure round-trip. The daemon self-ensures
      // the sandbox from `WorkItem.sandbox` when it dequeues the item
      // (cluster-connection-pull.ts:214: `input.provider.ensureSandbox(ensureInput)`),
      // so the warm-ensure that `resolveRemoteCliSandboxHandle` performed here
      // is redundant (C-bis S4). The handle formula is identical to what
      // `ensureSandbox`/`provisionSandbox` would compute. See `computeDesktopSandboxHandle`.
      let sandboxConfig: WorkItemSandbox | null = null;
      const harnessId: HarnessId =
        input.harnessId ?? resolveHarnessId(undefined);
      if (
        harnessId !== "decopilot" &&
        input.target?.runsIn === "user-desktop"
      ) {
        try {
          const sandboxHandle = computeDesktopSandboxHandle({
            agentId: input.agent.id,
            userId: input.userId,
            organizationId: input.organizationId,
            branch: input.branch ?? "ephemeral",
          });
          sandboxConfig = await resolvePullSandboxConfig(
            input,
            ctx,
            sandboxHandle,
          );
        } catch (err) {
          // Log but don't fail pullDispatch — the daemon falls back to
          // ensureSandbox({ handle }) for a running sandbox, and cold spawn
          // will fail loudly on the daemon side if the config is missing.
          console.warn(
            `[pullDispatch] failed to resolve sandbox config agent=${input.agent.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const orgSlug = ctx.organization?.slug ?? null;

      return {
        taskId,
        runFenceToken,
        harnessInput: effectiveHarnessInput,
        messagesRef,
        sandboxConfig,
        orgSlug,
      };
    },
    dispatchRunSpanAttrs(input),
  );
}

/**
 * Resolve the sandbox URL the cluster should dispatch a `remote-cli`
 * harness stream to. Calls `ensureSandbox` (lazy/idempotent — fast path
 * returns the existing entry, slow path provisions through the
 * desktop sandbox provider) so the resulting sandbox is the same one
 * SANDBOX_START / the always-on sandbox tools use. Returns the daemon's
 * `previewUrl`, which is the per-handle tunnel URL the cluster
 * already talks to directly.
 *
 * Branch defaults to `"ephemeral"` to match
 * `apps/mesh/src/api/routes/decopilot/routes.ts:434` — threads
 * without a connected repo share one sandbox per virtualMcp under
 * that synthetic branch.
 *
 * Exported so the unification can be unit-tested without standing up
 * the full `dispatchRunAndWait` machinery.
 */
export async function resolveRemoteCliSandboxUrl(
  input: { agent: { id: string }; branch?: string | null },
  ctx: StudioContext,
): Promise<string> {
  const { previewUrl } = await resolveRemoteCliSandboxHandle(input, ctx);
  return previewUrl;
}

/**
 * Pure, synchronous handle derivation — no I/O, no ensure round-trip.
 *
 * Mirrors the formula used by `ensureSandbox` / `provisionSandbox`:
 *   projectRef = composeSandboxRef({ orgId, virtualMcpId: agentId, branch })
 *   handle     = computeClaimHandle({ userId, projectRef }, branch)
 *
 * This is the SAME handle the daemon receives in `WorkItem.sandbox.handle`
 * (set by `resolvePullSandboxConfig`) and that the daemon derives via
 * `deriveHandle(item)`. Both sides agree by construction.
 *
 * Safe to call at dispatch-run sites where the daemon will self-ensure the
 * sandbox from the work item (cluster-connection-pull.ts:214 —
 * `input.provider.ensureSandbox(ensureInput)`). The warm-ensure
 * round-trip at those sites is therefore redundant and is replaced by this
 * pure call (C-bis S4 landmine #7).
 *
 * NOT a substitute at sites that return a preview URL outside the work-queue
 * path — `resolveRemoteCliSandboxUrl` must keep calling
 * `resolveRemoteCliSandboxHandle` (which runs the full ensure) because there
 * is no daemon self-ensure backstop for the preview-URL path.
 *
 * Exported for unit tests.
 */
export function computeDesktopSandboxHandle(input: {
  agentId: string;
  userId: string;
  organizationId: string;
  branch: string;
}): string {
  const projectRef = composeSandboxRef({
    orgId: input.organizationId,
    virtualMcpId: input.agentId,
    branch: input.branch,
  });
  return computeClaimHandle({ userId: input.userId, projectRef }, input.branch);
}

/**
 * Resolve (or provision) the desktop sandbox for `agent`+`branch` and return
 * both its `sandboxHandle` and `previewUrl`. The handle is the stable
 * identifier used by `remoteDispatch` to route `/_sandbox/<handle>/dispatch`
 * requests over NATS to the user's link daemon.
 */
async function resolveRemoteCliSandboxHandle(
  input: { agent: { id: string }; branch?: string | null },
  ctx: StudioContext,
): Promise<{ sandboxHandle: string; previewUrl: string }> {
  const entry = await ensureSandbox(
    {
      virtualMcpId: input.agent.id,
      branch: input.branch ?? "ephemeral",
      sandboxProviderKind: "user-desktop",
    },
    ctx,
  );
  if (!entry.previewUrl) {
    throw new Error(
      `Sandbox for agent ${input.agent.id} has no previewUrl — the desktop daemon may still be starting`,
    );
  }
  return { sandboxHandle: entry.sandboxHandle, previewUrl: entry.previewUrl };
}
