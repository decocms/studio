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

import type { MeshContext } from "@/core/mesh-context";
import { posthog } from "@/posthog";
import { type UIMessageChunk, createUIMessageStream } from "ai";
import { localDispatch } from "@/harnesses";
import { remoteDispatch } from "@/harnesses/remote-dispatch";
import { ensureVm } from "@/tools/vm/start";
import { LinkOfflineError } from "../../../links/link-offline-error";
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
import { uploadFileParts, resolveStorageRefs } from "./file-materializer";
import type { ToolApprovalLevel } from "./helpers";
import { type ChatMode } from "./mode-config";

export type { ChatMode } from "./mode-config";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import { buildOnTitleUpdated } from "./on-title-updated";
import {
  checkModelPermission,
  fetchModelPermissions,
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

/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a CLI
 * harness will use to talk to mesh's virtual-MCP gateway over HTTP. Only
 * called for harnesses that actually open an HTTP MCP connection
 * (claude-code, codex); decopilot's in-process passthrough doesn't need
 * this.
 *
 * `targetKind` decides which base URL to mint:
 *   - `"local"` — `getInternalUrl()` (loopback; the harness runs inside
 *     the cluster pod alongside the API).
 *   - `"remote-cli"` — `getPublicUrl()` (the harness runs on the user's
 *     desktop and dials the cluster back over the public network — or, in
 *     dev mode, localhost via `MESH_ALLOW_LOCALHOST_LINKS=1`).
 */
const MCP_KEY_TTL_SECONDS = 3600;

async function mintMcpEndpoint(
  ctx: MeshContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
  targetKind: DispatchTarget["kind"],
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
    targetKind === "remote-cli" ? getPublicUrl() : getInternalUrl();
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
   * `{ kind: "local", sandbox: "default" }` when omitted, preserving the
   * pre-Phase-4 behavior.
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
  ctx: MeshContext,
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

interface PreparedRun {
  taskId: string;
  uiStream: ReadableStream<unknown>;
  registrySignal: AbortSignal;
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
  ctx: MeshContext,
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
    // we re-read it here (defaulting to local/default for any caller —
    // e.g. legacy automation paths — that hasn't been migrated yet).
    //
    // An `error` target reaching this far means a request without a
    // pre-resolved target somehow slipped past the 409 in POST /messages.
    // Surface a typed exception so the gate workflow records the run as
    // failed instead of a generic stream error.
    const target: DispatchTarget = input.target ?? {
      kind: "local",
      sandbox: "default",
    };
    if (target.kind === "error") {
      throw new LinkOfflineError(target.reason, target.activeCapabilities);
    }

    // Stash the resolved target on the context so downstream consumers
    // (Phase 5's desktop sandbox provider, Phase 6's remote-cli
    // dispatch) can read it without re-querying the registry.
    if (target.kind === "local") {
      ctx.sandboxPreference = target.sandbox;
      ctx.linkForCurrentRun = target.link;
    } else {
      // remote-cli: no in-cluster sandbox runs, but we still hold the
      // link reference for the eventual remoteDispatch call below.
      ctx.linkForCurrentRun = target.link;
    }
    rootSpan.setAttribute("decopilot.dispatchTarget.kind", target.kind);
    if (target.kind === "local") {
      rootSpan.setAttribute("decopilot.dispatchTarget.sandbox", target.sandbox);
    }

    // 1. Check model permissions (decopilot-only; CLI harnesses run with
    //    the user's own provider credential / local CLI binary, which is
    //    already vetted at credential-creation time).
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
    }

    const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;

    if (!input.taskId) {
      throw new Error("dispatchRunAndWait: taskId is required");
    }

    // 2. Load entities and create/load memory in parallel
    const [virtualMcp, provider, mem] = await Promise.all([
      ctx.storage.virtualMcps.findById(input.agent.id, input.organizationId),
      harnessId === "decopilot"
        ? ctx.aiProviders.activate(
            input.models.credentialId,
            input.organizationId,
          )
        : Promise.resolve(null),
      createMemory(ctx.storage.threads, {
        organization_id: input.organizationId,
        thread_id: input.taskId,
        userId: input.userId,
        defaultWindowSize: windowSize,
      }),
    ]);

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
      await saveMessagesToThread(materializedRequestMessage);
    }

    let streamFinished = false;
    const pendingOps: Promise<void>[] = [];

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

    const uiStream = createUIMessageStream({
      originalMessages: allMessages,
      execute: async ({ writer }) => {
        // Resolve mesh-storage: URIs to fresh presigned URLs every turn.
        // Also handles legacy data: URLs from threads predating this pipeline.
        // `processConversation` (which depends on the harness-owned tool
        // set for `toModelOutput` handlers) runs inside the decopilot
        // harness itself; we forward materialized UIMessages so each
        // harness decides how to convert them.
        const materializedMessages = await resolveStorageRefs(allMessages, ctx);

        ensureModelCompatibility(input.models, materializedMessages);

        // Build the MCP endpoint for CLI harnesses. Decopilot doesn't
        // open an HTTP MCP connection (its passthrough client works
        // in-process), so we skip the API-key mint for that path.
        const mcp =
          harnessId === "decopilot"
            ? {
                url: "",
                headers: {} as Record<string, string>,
                // Sentinel for the in-process decopilot path — its
                // passthrough client doesn't consume mcp.* but the
                // shared HarnessStreamInput type requires the field.
                expiresAt: 0,
              }
            : await mintMcpEndpoint(
                ctx,
                input.agent.id,
                organization,
                harnessId === "claude-code"
                  ? "claude-code-session"
                  : "codex-session",
                target.kind,
              );

        // Build the in-process extras that decopilot needs to participate
        // in the surrounding `createUIMessageStream` scope. CLI harnesses
        // ignore this field.
        const toolOutputMap = new Map<string, string>();
        const pendingImages: PendingImage[] = [];
        const processLocal: HarnessProcessLocal = {
          writer,
          toolOutputMap,
          pendingImages,
          threadId: mem.thread.id,
          currentThreadTitle: mem.thread.title,
          registrySignal,
          runRegistry,
          provider,
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

        const harnessInput: HarnessStreamInput = {
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
          signal: registrySignal,
          processLocal,
        };

        // claude-code cwd resolution: with the `host` runner gone, the
        // cluster never has a local on-disk workdir to point the CLI at,
        // so the harness falls back to its own ambient cwd. Remote-user
        // dispatch runs the harness inside the desktop daemon, where the
        // daemon is spawned with workdir = sandbox path; remote-cli runs
        // claude-code in-process on the user's machine (no resolver
        // needed). Production runners (docker, agent-sandbox, freestyle)
        // don't surface a local FS to mesh.

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
        //   - `remote-cli` — the whole stream is delegated to the user's
        //     link daemon. `resolveRemoteCliSandboxUrl` calls `ensureVm`
        //     (handle == `computeHandle(sandboxId, branch)`) so the
        //     sandbox is the same one VM_START provisions — repo cloned,
        //     env pushed, dev server primed. The cluster talks to the
        //     daemon directly at the returned per-handle tunnel URL
        //     (`https://<handle>.deco.host` in prod), no link
        //     reverse-proxy hop. Per-run state inside the daemon stays
        //     keyed by `runId` (cancellation via DELETE
        //     /_decopilot_vm/runs/<runId>).
        //   - `local` (default OR desktop) — runs in-cluster.
        //     `desktop` only changes where the sandbox tool calls go;
        //     the harness still runs here.
        let harnessChunks;
        if (target.kind === "remote-cli") {
          // Unify with VM_START: resolve the sandbox via `ensureVm` so
          // claude-code/codex runs share the workdir VM_START already
          // provisioned (cloned repo + env + lockfile probe). Falls
          // through to a blank sandbox for ephemeral threads. See
          // `resolveRemoteCliSandboxUrl` below for why the helper
          // exists.
          const sandboxUrl = await resolveRemoteCliSandboxUrl(
            { agent: input.agent, branch: mem.thread.branch ?? input.branch },
            ctx,
          );
          harnessChunks = remoteDispatch(
            harnessId,
            harnessInput,
            target.link,
            sandboxUrl,
          );
        } else {
          harnessChunks = localDispatch(harnessId, harnessInput, ctx);
        }
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
        await saveMessagesToThread(responseMessage);

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
        saveMessagesToThread({
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: `Error: ${sanitized}` }],
          metadata: { errorCategory: classifyStreamError(error) },
        } as ChatMessage).catch((e) => {
          console.error("[decopilot:stream] error-message save failed", e);
        });

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
    return {
      taskId: mem.thread.id,
      uiStream,
      registrySignal,
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
 * Resolve the sandbox URL the cluster should dispatch a `remote-cli`
 * harness stream to. Calls `ensureVm` (lazy/idempotent — fast path
 * returns the existing entry, slow path provisions through the
 * desktop sandbox provider) so the resulting sandbox is the same one
 * VM_START / the always-on VM tools use. Returns the daemon's
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
  ctx: MeshContext,
): Promise<string> {
  const entry = await ensureVm(
    {
      virtualMcpId: input.agent.id,
      branch: input.branch ?? "ephemeral",
      sandboxProviderKind: "desktop",
    },
    ctx,
  );
  if (!entry.previewUrl) {
    throw new Error(
      `Sandbox for agent ${input.agent.id} has no previewUrl — the desktop daemon may still be starting`,
    );
  }
  return entry.previewUrl;
}
