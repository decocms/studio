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
 * streams consumed by the harness kernel (`consumeHarnessStream`) — the
 * ONLY consume-side stream layer. dispatch-run feeds the kernel a lazy
 * chunk source and run-lifecycle hooks (registry STEP_DONE/FINISH, thread
 * status, posthog); the kernel's output stream is the run's uiStream.
 */

import type { StudioContext } from "@/core/studio-context";
import { PermanentRunError } from "@/core/dispatch-errors";
import { posthog } from "@/posthog";
import type { UIMessageChunk } from "ai";
import { InProcessSandboxClient } from "@/harnesses/in-process-sandbox-client";
import type { MessagesRef } from "@decocms/harness/offload-messages";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackRuntime,
} from "@/tools/virtual/studio-pack";
import { computeClaimHandle } from "@/sandbox/claim-handle";
import { composeSandboxRef } from "@decocms/sandbox/provider";
import { normalizeCoAuthorIdentity } from "@decocms/sandbox/shared";
import {
  buildAnonymousCloneInfo,
  buildCloneInfo,
  ensureGithubCloneToken,
} from "@/shared/github-clone-info";
import { resolveRuntimeConfig } from "@/tools/sandbox/helpers";
import { deriveOffloadAllowlist } from "@/object-storage/offload-allowlist";
import { getSettings } from "@/settings";
import type { WorkItemSandbox } from "@/links/link-work-item";
import type { DispatchTarget } from "../../../links/resolve-dispatch-target";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import type {
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  HarnessId,
  HarnessStreamInput,
  HarnessUserContext,
  ModelSelection,
  ModelsConfig,
} from "@/harnesses";
import { createSecretModelSource } from "@/harnesses";
import type {
  DecopilotHttpMcpSource,
  DecopilotObjectStorageSource,
  HarnessWorkspace,
} from "@decocms/harness/types";
import { WORKSPACE_CWD_REPO } from "@decocms/harness/workspace-cwd";
import { createProviderFromSecret } from "@decocms/harness/decopilot/provider-from-secret";
import {
  classifyStreamError,
  stringifyError,
} from "@decocms/harness/decopilot/stream-error";
import { isCliHarness } from "@decocms/harness/cli-harness";
import { DEFAULT_WINDOW_SIZE, generateMessageId } from "./constants";
import { mintRunFenceToken } from "./dispatch-fence";
import { synthesizedErrorMessageId } from "./message-ids";
import { loadAndMergeMessages } from "./conversation";
import { PartEmitter } from "./part-emitter";
import { ProgressBumpThrottle } from "./progress-bump";
import { uploadFileParts, resolveStorageRefs } from "./file-materializer";
import type { ToolApprovalLevel } from "./helpers";
import { type ChatMode } from "./mode-config";

export type { ChatMode } from "./mode-config";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import {
  PREPARE_RUN_STATUS_STAGES,
  publishRunStatusStage,
  shouldPublishClusterRunStatus,
} from "./run-status-stage";
import type {
  HarnessStreamConsumerHooks,
  HarnessStreamTitleOptions,
} from "./consume-harness-stream";
import { ingestRun } from "./ingest-run";
import {
  checkModelPermission,
  fetchModelPermissions,
  filterToolTiersByPermission,
} from "./model-permissions";
import { normalizeClientModels } from "./normalize-client-models";
import type { RunRegistry } from "./run-registry";
import { resolveThreadStatus } from "./status";
import type { StreamBuffer } from "./stream-buffer";
import type { ChatMessage, ModelsConfig as ClientModelsConfig } from "./types";
import type { CancelBroadcast } from "./cancel-broadcast";
import { resolveCliSessionRef } from "./cli-session-messages";
import { getInternalUrl, getPublicUrl } from "@/core/server-constants";
import { mintOrgFsConfigJson } from "@/file-storage/mount/provisioning";
import { meter, traced } from "@/observability";
import { safeMemoryUsage } from "@/observability/profiling/safe-memory";
import { getPodId } from "@/core/pod-identity";
import type { SSEEvent } from "@/event-bus";
import { sleep } from "@decocms/std";

// Attributes onFinish event-loop cost by phase (settle = awaiting the
// accumulated pendingOps; save = the synchronous message-serialization +
// DB write). The standalone eventloop.delay timer can't know what phase it
// stalled in; this histogram closes that gap for the finish path.
const finishDurationHistogram = meter.createHistogram(
  "decopilot.finish.duration",
  {
    description: "Wall time of onFinish flush segments, tagged by phase",
    unit: "ms",
  },
);

// The per-finish payload-size probe re-stringifies the whole message (the very
// cost we're characterizing), so the heavy trace is gated to a canary pod.
const FINISH_TRACE = process.env.DECOPILOT_FINISH_TRACE === "1";

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
 * Defer stream construction until the first consumer pull.
 *
 * `prepareRun` must NOT start any harness work unless its `uiStream` is
 * actually consumed: `prepareLinkWorkDispatch` calls `prepareRun` solely for the run
 * claim + eager wire input and never consumes the stream — the daemon runs
 * the harness remotely from the published work item, so an eager start here
 * would double-dispatch the run. The AI SDK's `createUIMessageStream` runs
 * its `execute` callback (and drains `writer.merge` sources) EAGERLY at
 * construction time, so laziness must wrap the kernel construction itself:
 * the factory runs on the first `pull`, which is when the harness dispatch
 * actually starts. Cancelling before the first pull never invokes the
 * factory.
 *
 * `highWaterMark: 0` is load-bearing: with the default (1) the stream calls
 * `pull` at construction to pre-fill its queue, defeating the laziness.
 * For the same reason the factory must contain any `pipeThrough` wrapping
 * (e.g. `tapProgress`) — piping into a transform with the default writable
 * high-water mark eagerly pulls one chunk even with no downstream consumer.
 */
function lazyStream<T>(factory: () => ReadableStream<T>): ReadableStream<T> {
  let reader: ReadableStreamDefaultReader<T> | null = null;
  return new ReadableStream<T>(
    {
      async pull(controller) {
        try {
          reader ??= factory().getReader();
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Inputs to the agent-sandbox stream branch — the unified-pipeline pieces fed
 * into `ingestRun`.
 */
export interface AgentSandboxUiStreamInput {
  runId: string;
  fenceToken: string;
  chunks: AsyncIterable<UIMessageChunk>;
  streamBuffer: Pick<StreamBuffer, "publishRawChunk" | "publishDone">;
  /** Title interception. `ingestRun` replaces `persistTitle` with a NO-OP so
   *  the durable projector is the sole writer. */
  title: HarnessStreamTitleOptions;
  hooks: HarnessStreamConsumerHooks;
  /** Deterministic id for a synthesized error message (`error-${runId}`) so
   *  projector-only persistence dedupes retries. */
  errorMessageId?: string;
  /** Publishes debounced checkpoint markers so the projector materializes
   *  parts + title incrementally. Omitted → no incremental projection. */
  checkpointPublisher?: (
    fenceToken: string,
    headSeq: number,
  ) => Promise<boolean>;
}

/**
 * Build the agent-sandbox run's UI stream (unified pipeline — the only path).
 *
 * The raw harness chunks are wrapped as `(seq, chunk)` (monotonic counter) and
 * fed through the shared `ingestRun` unit, which publishes each chunk to
 * JetStream with a seq-keyed `Nats-Msg-Id` and drives the live hooks (usage /
 * posthog completion / SSE finish) + title-chunk injection. `ingestRun`
 * neutralizes title/message persistence so the durable projector is the sole
 * writer of parts + status + title. The returned stream yields NOTHING (raw
 * chunks are the NATS source); the pump that drains it still publishes the
 * `{done}` sentinel so tails close.
 */
export function buildAgentSandboxUiStream(
  input: AgentSandboxUiStreamInput,
): ReadableStream {
  // Route through the shared ingestRun unit. Raw chunks → JetStream (seq-keyed
  // dedup); hooks + title injection fire once; ZERO DB writes here.
  let seq = 0;
  async function* seqChunks(): AsyncGenerator<{
    seq: number;
    chunk: UIMessageChunk;
  }> {
    for await (const chunk of input.chunks) {
      yield { seq: ++seq, chunk };
    }
  }
  return new ReadableStream({
    async start(controller) {
      try {
        await ingestRun(
          {
            runId: input.runId,
            fenceToken: input.fenceToken,
            chunks: seqChunks(),
            errorMessageId: input.errorMessageId,
          },
          {
            streamBuffer: input.streamBuffer,
            hooks: input.hooks,
            title: input.title,
            checkpointPublisher: input.checkpointPublisher,
          },
        );
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
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

export function buildHarnessWorkspaceInput(input: {
  virtualMcp: { metadata?: unknown } | null;
  branch?: string | null;
}): HarnessWorkspace {
  const githubRepo = (
    input.virtualMcp?.metadata as { githubRepo?: unknown } | undefined
  )?.githubRepo;
  const repo =
    githubRepo &&
    typeof (githubRepo as { owner?: unknown }).owner === "string" &&
    typeof (githubRepo as { name?: unknown }).name === "string"
      ? {
          owner: (githubRepo as { owner: string }).owner,
          name: (githubRepo as { name: string }).name,
          connectedGithub: Boolean(
            (githubRepo as { connectionId?: unknown }).connectionId,
          ),
        }
      : undefined;

  if (!repo) return { cwd: null };

  return {
    cwd: WORKSPACE_CWD_REPO,
    repo,
    branch: input.branch ?? null,
  };
}

async function resolveSecretModelSource(
  ctx: StudioContext,
  organizationId: string,
  credentialId: string,
  modelId: string,
): Promise<DecopilotSecretModelSource> {
  const { keyInfo, apiKey } = await ctx.storage.aiProviderKeys.resolve(
    credentialId,
    organizationId,
  );
  return createSecretModelSource({
    providerId: keyInfo.providerId,
    apiKey,
    modelId,
  });
}

/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a CLI
 * harness will use to talk to mesh's virtual-MCP gateway over HTTP. Only
 * called for harnesses that actually open an HTTP MCP connection
 * (claude-code, codex); decopilot's in-process passthrough doesn't need
 * this.
 *
 * `sandboxProviderKind` decides which base URL to mint:
 *   - `"agent-sandbox"` — `getInternalUrl()` (loopback; the harness runs
 *     in hosted execution alongside the API).
 *   - `"user-desktop"` — `getPublicUrl()` (the harness runs on the user's
 *     laptop and dials mesh back over the public network).
 */
const MCP_KEY_TTL_SECONDS = 3600;

async function mintMcpEndpoint(
  ctx: StudioContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
  sandboxProviderKind: DispatchTarget["sandboxProviderKind"],
): Promise<{
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}> {
  const apiKey = await ctx.boundAuth.apiKey.create({
    name: apiKeyName,
    // The per-run key is the agent's own callback credential — it proxies to
    // `/mcp/virtual-mcp/<agentId>` (a `vir_*` resource) and acts on behalf of
    // the user for the duration of the run, so it needs full access. With no
    // implicit default (auth/index.ts), the scope must be explicit; wildcard
    // matches the prior behavior (full access via the admin bypass).
    permissions: { "*": ["*"] },
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
    sandboxProviderKind === "user-desktop" ? getPublicUrl() : getInternalUrl();
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
  /** CLIENT request shape (root credentialId). `prepareRun` normalizes it
   *  into the per-slot harness/wire `ModelsConfig` before dispatch. */
  models: ClientModelsConfig;
  agent: AgentConfig;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  /**
   * Optional allowlist of model-facing tool names the run is restricted to.
   * Applied after the full toolset (MCP + built-ins) is assembled. `null` or
   * omitted leaves the agent's full toolset intact. Used by automations that
   * pin a specific subset of tools.
   */
  toolAllowlist?: string[] | null;
  /**
   * Parent agent-loop step cap (AI SDK `stopWhen`). Omitted leaves the loop
   * on its `PARENT_STEP_LIMIT` default. Set by automations that need a higher
   * (or lower) ceiling than the platform default.
   */
  maxAgentSteps?: number;
  /**
   * Run is a backgrounded subtask dispatched as its own serialized run on the
   * parent thread. Skips history-seeding (fresh subagent context) and runs
   * `kind: "subagent"` (no nested subtask). The prompt rides the request message
   * (typically `metadata.internal` so it's hidden); `maxAgentSteps` caps it.
   */
  isSubagent?: boolean;
  /** Backgrounded-subtask correlation: the originating tool call's job id,
   *  stamped onto the run's message metadata so the UI nests it in that card. */
  subtaskJobId?: string;
  /** This turn was auto-enqueued to resume the agent after a backgrounded tool
   *  (image / subtask) completed. Stamped onto the message metadata so the UI
   *  shows a "resumed" indicator. */
  resumedFromBackground?: boolean;
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
   * `{ sandboxProviderKind: "agent-sandbox" }` when omitted, preserving
   * hosted execution for legacy callers.
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
  /** When provided, hosted runs can emit live title SSE events for tabs that
   *  are not subscribed to the per-thread `/stream`. Durable title persistence
   *  is projector-owned. Optional — callers without an sseHub (e.g.
   *  background/non-interactive dispatch paths) may omit it. */
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
}

export interface DispatchRunResult {
  taskId: string;
}

// ============================================================================
// Core Logic
// ============================================================================

function dispatchRunSpanAttrs(input: DispatchRunInput): Record<string, string> {
  const clientModels = input.models;
  return {
    "decopilot.agent.id": input.agent.id,
    "decopilot.model.id": clientModels.thinking.id,
    "decopilot.credential.id": clientModels.credentialId,
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
        buffer.pump(uiStream, taskId, registrySignal, input.organizationId);
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
        // This still executes the hosted producer path; when the streamBuffer
        // itself is healthy, ingestRun publishes chunks/done to JetStream and
        // the projector materializes the run. In a NATS deployment this branch
        // means the producer could not create its local tail, so the blocking
        // waiter is degraded even though publishing may still succeed.
        if (buffer) {
          console.warn(
            JSON.stringify({
              msg: "decopilot-stream-diag",
              event: "producer-fallback-no-pump",
              taskId,
              hasTail: !!tail,
              note: "createTailStream returned null — draining producer stream directly; projector persistence depends on streamBuffer publish health",
            }),
          );
        }
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
 * input — everything `HarnessStreamInput` carries EXCEPT the non-serializable
 * `signal` field. This is exactly what the desktop daemon validates against
 * `harnessStreamInputSchema` and what the link work item carries.
 *
 * Built eagerly in `prepareRun`'s main body (mcp mint + userMessage
 * materialization + field assembly) so it's available without consuming
 * `uiStream`. The hosted dispatch path layers the signal on top inside the
 * lazy harness chunk source:
 * `{ ...wireHarnessInput, signal: registrySignal }`.
 */
export type WireHarnessInput = Omit<HarnessStreamInput, "signal"> & {
  harnessId: HarnessId;
};

interface PreparedRun {
  taskId: string;
  /**
   * LAZY: no harness work happens until the first consumer pull (see
   * `lazyStream`). Callers that never consume it (`prepareLinkWorkDispatch`) never
   * start a cluster-side harness run.
   */
  uiStream: ReadableStream<unknown>;
  registrySignal: AbortSignal;
  /** Minted by prepareRun for link-dispatched threads. */
  runFenceToken: string;
  /**
   * Fully-assembled wire harness input (mcp minted, userMessage materialized,
   * fence token attached). `dispatchRunAndWait` ignores this (it consumes
   * `uiStream`); `prepareLinkWorkDispatch` returns it so the gate can publish
   * it as the link work item's `harnessInput`.
   */
  wireHarnessInput: WireHarnessInput;
}

/**
 * Pre-resolve the per-user prompt data the portable prompt builder renders:
 * recent threads (continuity), interests (durable goals), and sibling agents
 * (the `<available-agents>` block). Read agent-side here — the harness never
 * touches `ctx.storage`. Each read is independently best-effort; a failure
 * drops only its sub-block (matching the prior in-prompt `.catch(() => null)`).
 *
 * NOTE: `ctx.storage.threads` is the org-scoped decorator (`OrgScopedThreadStorage`),
 * whose `list(createdBy?, options?)` binds the org implicitly — so we pass
 * `(userId, { limit, agentId })`, NOT `(organizationId, userId, …)`.
 */
export async function resolveUserContext(
  ctx: StudioContext,
  organizationId: string,
  agentId: string,
  userId: string,
): Promise<HarnessUserContext> {
  const [recent, interestsDoc, agentList] = await Promise.all([
    ctx.storage.threads.list(userId, { limit: 9, agentId }).catch(() => null),
    ctx.storage.interests
      .getForAgent(organizationId, agentId, userId)
      .catch(() => null),
    ctx.storage.virtualMcps.list(organizationId).catch(() => null),
  ]);
  const result: HarnessUserContext = {};
  if (recent && recent.total > 0) {
    result.recentThreads = {
      total: recent.total,
      threads: recent.threads.map((t) => ({
        id: t.id,
        title: t.title,
        updated_at: t.updated_at,
      })),
    };
  }
  if (interestsDoc && interestsDoc.interests.length > 0) {
    result.interests = interestsDoc.interests.map((i) => ({
      title: i.title,
      summary: i.summary,
    }));
  }
  if (agentList) {
    result.agents = agentList.map((vm) => ({
      id: vm.id,
      name: vm.title,
      description: vm.description,
      status: vm.status,
    }));
  }
  return result;
}

export async function resolveEffectiveVirtualMcpForHarness({
  virtualMcp,
  agentId,
  organizationId,
  ctx,
}: {
  virtualMcp: VirtualMCPEntity;
  agentId: string;
  organizationId: string;
  ctx: StudioContext;
}): Promise<VirtualMCPEntity> {
  const studioPackAgent = findStudioPackAgentByMcpId(agentId);
  if (!studioPackAgent) return virtualMcp;

  const resolved = await resolveStudioPackRuntime(studioPackAgent, {
    orgId: organizationId,
    ctx,
  });
  const selectedTools = resolved.selectedTools
    ? [...resolved.selectedTools]
    : null;

  return {
    ...virtualMcp,
    metadata: {
      ...((virtualMcp.metadata as Record<string, unknown>) ?? {}),
      instructions: resolved.instructions,
    },
    connections: virtualMcp.connections.map((connection) => ({
      ...connection,
      selected_tools: selectedTools,
    })),
  };
}

/**
 * Setup phase shared by both dispatch variants. Claims the run, loads
 * conversation history, assembles the wire harness input, and constructs a
 * LAZY `uiStream` whose first pull dispatches through the harness registry
 * and consumes the chunks via the harness kernel (`consumeHarnessStream`).
 * Returns the stream to whoever called it; the caller decides how to
 * consume it (pump for fan-out, drain for direct await) — or, for
 * `prepareLinkWorkDispatch`, not at all (no cluster-side harness runs then).
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
  const { runRegistry, streamBuffer } = deps;

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
    // The HTTP layer still sends the CLIENT models shape (root credentialId,
    // optional client-only extras like `capabilities`). Everything below the
    // normalization call uses the per-slot v2 `models`.
    const clientModels = input.models;
    const credentialKey = await ctx.storage.aiProviderKeys
      .findById(clientModels.credentialId, input.organizationId)
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
    // we re-read it here (defaulting to a hosted target for any
    // caller — e.g. legacy automation paths — that hasn't been migrated
    // yet).
    const target: DispatchTarget = input.target ?? {
      sandboxProviderKind: "agent-sandbox",
    };

    // Stash the resolved target on the context so downstream consumers
    // (the desktop sandbox provider, remote-cli dispatch) can read it
    // without re-querying the registry.
    if (target.sandboxProviderKind === "agent-sandbox") {
      ctx.sandboxPreference = "agent-sandbox";
    } else {
      // user-desktop: downstream sandbox tools should use the desktop
      // provider.
      ctx.sandboxPreference = "user-desktop";
    }
    rootSpan.setAttribute(
      "decopilot.dispatchTarget.sandboxProviderKind",
      target.sandboxProviderKind,
    );

    const shouldPublishRunStatus = shouldPublishClusterRunStatus({
      harnessId,
      sandboxProviderKind: target.sandboxProviderKind,
    });

    // Normalize the client models payload into the v2 per-slot shape FIRST
    // (the HTTP layer still sends a root credentialId), so the permission
    // check and slot resolution below read the per-slot credential. See
    // `normalize-client-models.ts` for the slot/credential/stripping rules.
    let models: ModelsConfig = normalizeClientModels(clientModels);

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
          models.thinking.credentialId,
          models.thinking.id,
        )
      ) {
        throw new Error("Model not allowed for your role");
      }
      // NOTE: only image/deepResearch are filtered today — fast/smart must be
      // added here when they gain a producer.
      models = filterToolTiersByPermission(allowedModels, models);
    }

    const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;

    if (!input.taskId) {
      throw new Error("dispatchRunAndWait: taskId is required");
    }
    if (shouldPublishRunStatus) {
      await publishRunStatusStage(
        streamBuffer,
        input.taskId,
        PREPARE_RUN_STATUS_STAGES[0],
      );
    }

    // 2. Load entities, create/load memory, and resolve Decopilot model
    // credentials in parallel — one resolution per configured slot, each
    // against its own credential. The harness receives serializable secret
    // sources and reconstructs SDK providers locally in both cluster and
    // desktop execution.
    const resolveSlot = (slot?: ModelSelection) =>
      harnessId === "decopilot" && slot
        ? resolveSecretModelSource(
            ctx,
            input.organizationId,
            slot.credentialId,
            slot.id,
          )
        : Promise.resolve(undefined);
    const [
      virtualMcp,
      thinkingSource,
      fastSource,
      smartSource,
      imageSource,
      webSearchSource,
      deepResearchSource,
      mem,
      userContext,
    ] = await Promise.all([
      ctx.storage.virtualMcps.findById(input.agent.id, input.organizationId),
      resolveSlot(models.thinking),
      resolveSlot(models.fast),
      resolveSlot(models.smart),
      resolveSlot(models.image),
      resolveSlot(models.webSearch),
      resolveSlot(models.deepResearch),
      createMemory(ctx.storage.threads, {
        organization_id: input.organizationId,
        thread_id: input.taskId,
        userId: input.userId,
        defaultWindowSize: windowSize,
      }),
      // Pre-resolve threads/interests/sibling-agents agent-side so the portable
      // prompt builder renders them without any `ctx.storage` reach-in. Only
      // hosted decopilot runs need it; desktop runs leave it absent so the
      // corresponding prompt blocks skip.
      harnessId === "decopilot" && target.sandboxProviderKind !== "user-desktop"
        ? resolveUserContext(
            ctx,
            input.organizationId,
            input.agent.id,
            input.userId,
          )
        : Promise.resolve(undefined),
    ]);
    if (shouldPublishRunStatus) {
      await publishRunStatusStage(
        streamBuffer,
        input.taskId,
        PREPARE_RUN_STATUS_STAGES[1],
      );
    }

    const modelSources: DecopilotSecretModelSources | undefined = thinkingSource
      ? {
          thinking: thinkingSource,
          ...(fastSource ? { fast: fastSource } : {}),
          ...(smartSource ? { smart: smartSource } : {}),
          ...(imageSource ? { image: imageSource } : {}),
          ...(webSearchSource ? { webSearch: webSearchSource } : {}),
          ...(deepResearchSource ? { deepResearch: deepResearchSource } : {}),
        }
      : undefined;

    const primaryProvider = thinkingSource
      ? createProviderFromSecret(thinkingSource)
      : null;

    // Diagnostic (resume only): record whether the model secret resolved and
    // whether the optional model slots are present. Paired with the log in
    // routes.ts:/attach orphan-resume; together they pinpoint whether tool
    // dropout on resume is a persistence-side or model-resolution issue.
    // Drop once the resume-tool-dropout issue is root-caused.
    if (input.isResume) {
      console.log("[decopilot:stream] resume — resolved source state", {
        taskId: input.taskId,
        harnessId,
        thinkingSourceResolved: !!thinkingSource,
        imageSourceResolved: !!imageSource,
        webSearchSourceResolved: !!webSearchSource,
        deepResearchSourceResolved: !!deepResearchSource,
        thinkingModelId: models.thinking.id,
        hasImage: !!models.image,
        hasWebSearch: !!models.webSearch,
        hasDeepResearch: !!models.deepResearch,
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
    if (primaryProvider?.asyncResearch) {
      const slots: Array<["thinking" | "fast" | "smart" | "image", string]> = [
        ["thinking", models.thinking.id],
      ];
      if (models.fast) slots.push(["fast", models.fast.id]);
      if (models.smart) slots.push(["smart", models.smart.id]);
      if (models.image) slots.push(["image", models.image.id]);
      for (const [slot, modelId] of slots) {
        if (primaryProvider.asyncResearch.canHandle(modelId)) {
          throw new Error(
            `Model "${modelId}" can only be used as a Deep Research model. ` +
              `It is not usable as the ${slot} model — set it in the Deep Research slot instead.`,
          );
        }
      }
    }

    // ── Stream-of-record v2 write path (unified pipeline) ───────────────────
    // `isV2` is read straight off the thread row's pinned
    // `message_storage_version`. New threads are pinned v2 unconditionally at
    // the first-message site in routes.ts (Phase C cutover — v2 is the only
    // write path), so `partEmitter` is present for every new run. Pre-existing
    // v1 threads (`message_storage_version === 1`) are DEPRECATED read-only
    // legacy: the v1 write path was deleted in the Phase C cutover, so only v2
    // threads get a user-message part emitter. The user message is persisted
    // here (before dispatch); the assistant parts + terminal status + title are
    // written by the durable projector — `buildAgentSandboxUiStream` only
    // publishes raw chunks to JetStream (zero DB writes).
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
      throw new PermanentRunError("agent_not_found", "Agent not found");
    }
    const effectiveVirtualMcp = await resolveEffectiveVirtualMcpForHarness({
      virtualMcp,
      agentId: input.agent.id,
      organizationId: input.organizationId,
      ctx,
    });

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

    // Clear any durable cancel flag from a PRIOR run on this thread. The flag
    // (`cancel_requested_at`) is per-run intent — it cancels the run that was
    // in flight when the user hit stop — but runId == threadId, so it lingers
    // on the row forever once set. Without this clear, validateRunAccess would
    // 409 ("cancelled") every future pull relay on the thread (the flag has no
    // other caller — clearCancelRequested was previously unreferenced). A new
    // run starting IS the user's intent to proceed, so reset it here, in the
    // same place the fence is minted/overwritten.
    await ctx.storage.threads.clearCancelRequested(mem.thread.id);

    // Mint the single-writer fence token for this run. The token is
    // included in HarnessStreamInput so the daemon presents it on every
    // ingest append. Minting after START ensures the run is claimed before
    // the token exists; clearing on FINISH is the gate's responsibility.
    // It is fresh PER TURN (runId == threadId is stable across turns) so the
    // fence-scoped JetStream dedup key (`runId:fenceToken:seq`) and the
    // projector's per-(runId, fenceToken) accumulator never collide two turns.
    // On DBOS replay this re-mints a new token while a queued work item carries the old one —
    // reconcile when Phase D wires the publish off the persisted column.
    // Note: a failed link run leaves run_fence_token set until Task 7 clears it
    // (harmless: next run overwrites; ws/cloud never read it).
    const runFenceToken = mintRunFenceToken();
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
    // mesh-storage: URIs instead of base64 data: blobs. threadId routes the
    // bytes into the org-fs uploads volume (org/upload in the sandbox).
    const materializedRequestMessage = requestMessage
      ? ((
          await uploadFileParts([requestMessage], ctx, {
            threadId: mem.thread.id,
          })
        ).find((m) => m.role !== "system") as typeof requestMessage)
      : undefined;

    if (!input.isResume) {
      if (!materializedRequestMessage) {
        throw new PermanentRunError(
          "empty_request",
          "No user message found in input — expected at least one non-system message",
        );
      }
      if (partEmitter) {
        // v2: persist the user message's parts + a finish anchor so the
        // message is immediately complete in the parts read path. (v1 threads
        // are deprecated read-only legacy — no write path; partEmitter is null.)
        await partEmitter
          .emitUserMessage(materializedRequestMessage)
          .catch((error) => {
            console.error(
              "[decopilot:stream] v2 user-message emit failed",
              error,
            );
          });
      }
    }

    const pendingOps: Promise<void>[] = [];

    // Pre-load conversation (no system messages — those are built separately)
    // When resuming, requestMessage is undefined — conversation loads entirely
    // from DB via createMemory / loadAndMergeMessages.
    const allMessages = await loadAndMergeMessages(
      mem,
      materializedRequestMessage,
      systemMessages,
      windowSize,
      input.isSubagent === true,
    );

    // CLI-harness delta + resume only holds on the long-lived desktop daemon:
    // the on-disk session survives between turns *only* on user-desktop. On any
    // other sandbox kind there is no persistent rollout to resume, so fall back
    // to the full-transcript path (pre-resume behavior) rather than silently
    // dropping history or pointing the CLI at a session that isn't there.
    const cliResumable =
      isCliHarness(harnessId) && target.sandboxProviderKind === "user-desktop";

    const resumeSessionRef = cliResumable
      ? resolveCliSessionRef(allMessages, harnessId)
      : undefined;

    const organization = ctx.organization!;
    const streamStartAt = Date.now();

    // ── Build the wire HarnessStreamInput EAGERLY ───────────────────────────
    // Everything the daemon's `harnessStreamInputSchema` needs (mcp endpoint,
    // materialized userMessage, workspace, fence token, …) is assembled here,
    // before the lazy harness chunk source runs. Two consumers read it:
    //   - hosted dispatch (`dispatchHarnessChunks` below) layers the
    //     non-serializable `signal` on top:
    //     `{ ...wireHarnessInput, signal: registrySignal }`.
    //   - `prepareLinkWorkDispatch` returns it verbatim so the thread gate can
    //     publish it as the link work item's `harnessInput`.

    // Resolve mesh-storage: URIs to fresh presigned URLs for the current user
    // message only. The v3 harness contract carries one wire-ready userMessage;
    // long-lived CLI context is represented separately by harness.sessionId.
    const wireUserMessage = materializedRequestMessage
      ? (await resolveStorageRefs([materializedRequestMessage], ctx))[0]
      : undefined;

    if (!wireUserMessage) {
      throw new PermanentRunError(
        "empty_request",
        "No user message found in input — expected at least one non-system message",
      );
    }

    ensureModelCompatibility(input.models, [wireUserMessage]);

    // Build the MCP endpoint for CLI harnesses. Hosted decopilot uses an
    // in-process passthrough client (no HTTP MCP connection needed), so we
    // use a sentinel for that path. Desktop decopilot requires a real endpoint
    // so the daemon can reach cluster-side MCP tools.
    const mcpBase =
      harnessId === "decopilot" && target.sandboxProviderKind !== "user-desktop"
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
            target.sandboxProviderKind,
          );

    // ⚠️ SECURITY: Decopilot receives resolved model secret sources, never
    // activated provider objects. For hosted cluster execution these stay
    // in-process; for user-desktop execution they transit to the daemon over
    // the link transport so the same harness contract works in both places.
    // Never log `modelSources` (any slot) or `mcp.headers` values.

    const mcp: HarnessStreamInput["mcp"] = mcpBase;
    const mcpSource: DecopilotHttpMcpSource | undefined =
      mcp.expiresAt > 0
        ? {
            kind: "http",
            url: mcp.url,
            headers: mcp.headers,
            expiresAt: mcp.expiresAt,
          }
        : undefined;
    const objectStorageSource: DecopilotObjectStorageSource | undefined =
      target.sandboxProviderKind === "user-desktop" && organization.slug
        ? {
            kind: "http",
            baseUrl: `${getPublicUrl()}/api/${encodeURIComponent(organization.slug)}/object-storage`,
            headers: mcp.headers,
            expiresAt: mcp.expiresAt,
          }
        : undefined;
    const workspace = buildHarnessWorkspaceInput({
      virtualMcp: effectiveVirtualMcp,
      branch: input.branch,
    });
    const agentInstructions =
      typeof (effectiveVirtualMcp.metadata as { instructions?: unknown })
        ?.instructions === "string"
        ? (effectiveVirtualMcp.metadata as { instructions: string })
            .instructions
        : undefined;
    const decopilotRunContext = {
      taskId: input.taskId,
      isSubagent: input.isSubagent,
      subtaskJobId: input.subtaskJobId,
      resumedFromBackground: input.resumedFromBackground,
      virtualMcp: effectiveVirtualMcp,
      modelSources,
      mcpSource,
      objectStorageSource,
      userContext,
    };
    void decopilotRunContext;

    const wireHarnessInput: WireHarnessInput = {
      harnessId,
      threadId: mem.thread.id,
      userMessage: wireUserMessage,
      harness: { sessionId: resumeSessionRef },
      workspace,
      models,
      mcp,
      mode: input.mode,
      temperature: input.temperature,
      toolApprovalLevel: input.toolApprovalLevel,
      toolAllowlist: input.toolAllowlist ?? null,
      maxAgentSteps: input.maxAgentSteps,
      user: { id: input.userId, email: ctx.auth.user?.email ?? "" },
      organizationId: input.organizationId,
      organizationSlug: organization.slug,
      agent: { id: input.agent.id, instructions: agentInstructions },
      triggerId: input.triggerId,
      currentThreadTitle: mem.thread.title,
      runFenceToken,
    };

    // ── LAZY harness dispatch ───────────────────────────────────────────────
    // This generator's body — local harness dispatch — runs only when the
    // kernel pulls the first chunk, which (via `lazyStream` below) happens only
    // once a consumer pulls `uiStream`. `prepareLinkWorkDispatch` never consumes the
    // stream, so link-transport runs never start a cluster-side harness.
    //
    // claude-code cwd resolution: with the `host` runner gone, hosted execution
    // never has a local on-disk workdir to point the CLI at, so the harness
    // falls back to its own ambient cwd. The agent-sandbox runner doesn't
    // surface a local FS to mesh.
    //
    // When a streamBuffer is wired, its JetStream pump consumes `uiStream`
    // directly after prepareRun returns and publishes every chunk into the
    // per-task subject — that's what /stream tails.
    //
    // Transport Convergence: this generator only ever runs HOSTED
    // (agent-sandbox / legacy) harnesses via `localDispatch`. EVERY user-desktop
    // run goes through the link transport (`prepareLinkWorkDispatch` + tunnel
    // work publisher), which never consumes this stream — so a user-desktop target reaching here is a
    // hard bug (the guard below throws). The push `remoteDispatch` path is
    // deleted.
    if (shouldPublishRunStatus) {
      await publishRunStatusStage(
        streamBuffer,
        input.taskId,
        PREPARE_RUN_STATUS_STAGES[2],
      );
    }
    const dispatchHarnessChunks =
      async function* (): AsyncIterable<UIMessageChunk> {
        // Layer the non-serializable `signal` onto the eagerly-built wire
        // input. Everything else (mcp, materialized userMessage, fence token, …)
        // was assembled above and is shared verbatim with the desktop work item.
        const harnessInput: HarnessStreamInput = {
          ...wireHarnessInput,
          signal: registrySignal,
        };

        // User-desktop runs are routed by the gate to the link work publisher,
        // which never consumes this lazy stream. Reaching this generator for a
        // user-desktop target means the gate routing diverged from the dispatch
        // path — a hard bug.
        if (target.sandboxProviderKind === "user-desktop") {
          throw new Error(
            "user-desktop runs use the link transport — dispatchRunAndWait must not run a local harness for them",
          );
        }
        // hosted / agent-sandbox only. Step 1a: the in-process SandboxClient
        // wraps the prior `localDispatch(harnessId, harnessInput, ctx)` path
        // UNCHANGED — same AsyncIterable<UIMessageChunk>, same throw on unknown
        // id, same ctx forwarding. consumeHarnessStream consumes it verbatim.
        if (shouldPublishRunStatus) {
          await publishRunStatusStage(
            streamBuffer,
            mem.thread.id,
            PREPARE_RUN_STATUS_STAGES[3],
          );
        }
        const sandboxClient = new InProcessSandboxClient({ ctx, harnessId });
        const rawHarnessChunks = sandboxClient.dispatch(harnessInput);
        yield* rawHarnessChunks;
      };

    // The kernel (`consumeHarnessStream`) is the ONLY consume-side stream
    // layer: it intercepts title chunks, extracts usage, and drives the
    // run-lifecycle hooks below (formerly the callbacks of a second outer
    // `createUIMessageStream` wrapper). Ingest is persistence-free; the
    // projector materializes assistant messages later from JetStream. Its
    // output IS the run's uiStream. Constructed lazily via `lazyStream`
    // because the kernel starts pulling — and therefore dispatching — the
    // harness chunk source immediately on construction.
    //
    // `consumed.whenComplete` deliberately does NOT land in `pendingOps`:
    // the finish hook below runs INSIDE the kernel's completion path, before
    // `whenComplete` resolves, so awaiting it from there would deadlock. The
    // ordering that matters now is that the same lazy kernel path publishes
    // the JetStream chunks before invoking the finish hook.
    // The progress tap (the run's liveness heartbeat) lives INSIDE the lazy
    // factory: `pipeThrough` at the return site would eagerly pull one chunk
    // through the lazy stream even with no consumer (transform writable
    // high-water mark), starting the harness for never-consumed link runs.
    const uiStream = lazyStream(() =>
      tapProgress(
        buildAgentSandboxUiStream({
          runId: mem.thread.id,
          fenceToken: runFenceToken,
          streamBuffer: streamBuffer ?? {
            publishRawChunk: async () => false,
            publishDone: async () => false,
          },
          checkpointPublisher: streamBuffer
            ? (fenceToken, headSeq) =>
                streamBuffer.publishCheckpoint(
                  mem.thread.id,
                  fenceToken,
                  headSeq,
                )
            : undefined,
          chunks: dispatchHarnessChunks(),
          // Deterministic per turn (runId + fence) so a synthesized error
          // message dedupes across the live write + projector retries while
          // distinct turns of the same thread never collide. See message-ids.ts.
          errorMessageId: synthesizedErrorMessageId(
            mem.thread.id,
            runFenceToken,
          ),
          title: {
            currentThreadTitle: mem.thread.title,
            threadId: mem.thread.id,
            // Projector owns the title write — `ingestRun` neutralizes this
            // persistence callback. The projector is the sole sidebar-SSE
            // source for both hosted and desktop now.
            persistTitle: async (threadId, title) => {
              await ctx.storage.threads.update(threadId, { title });
            },
          },
          hooks: {
            onStep: () => {
              const transitions = runRegistry.dispatch({
                type: "STEP_DONE",
                taskId: mem.thread.id,
              });
              pendingOps.push(
                runRegistry.react(transitions).catch((e) => {
                  console.error(
                    "[decopilot:stream] onStepFinish reactor failed",
                    e,
                  );
                }),
              );
            },
            onFinish: async (responseMessage, finishReason) => {
              const pendingCount = pendingOps.length;

              // Phase 1 (settle): await the dispatch-level side-effect ops
              // accumulated during the run (step reactors). The kernel already
              // settled its own pending before invoking this hook, so this
              // segment isolates the dispatch-side flush cost.
              const settleStart = performance.now();
              await Promise.allSettled(pendingOps);
              finishDurationHistogram.record(performance.now() - settleStart, {
                phase: "settle",
              });

              if (registrySignal.aborted) return;

              // Yield a macrotask before the synchronous finish bookkeeping so
              // the settle-burst of pending-op continuations and the FINISH
              // reactor's DB write don't run in one tick — lets queued I/O
              // (health probes) get a turn and caps the worst onFinish
              // event-loop stalls.
              await sleep(0);

              const heapBefore = FINISH_TRACE ? safeMemoryUsage() : null;
              const saveStart = performance.now();

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

              const saveMs = performance.now() - saveStart;
              finishDurationHistogram.record(saveMs, { phase: "save" });

              if (FINISH_TRACE && heapBefore) {
                const heapAfter = safeMemoryUsage() ?? heapBefore;
                let messageBytes = -1;
                try {
                  messageBytes = JSON.stringify(responseMessage)?.length ?? -1;
                } catch {
                  // circular/oversized — leave -1
                }
                console.warn(
                  JSON.stringify({
                    msg: "decopilot-finish-trace",
                    threadId: mem.thread.id,
                    pendingOps: pendingCount,
                    saveMs: Math.round(saveMs),
                    parts: responseMessage?.parts?.length ?? 0,
                    messageBytes,
                    rssDelta: heapAfter.rss - heapBefore.rss,
                    heapUsedDelta: heapAfter.heapUsed - heapBefore.heapUsed,
                    externalDelta: heapAfter.external - heapBefore.external,
                  }),
                );
              }

              // Completion analytics are emitted by the projector after the
              // same fenced JetStream log is durably materialized.
            },
            onError: (error) => {
              if (registrySignal.aborted) {
                // User cancelled (frontend stop button), tab closed mid-stream,
                // or run was force-failed. Frontend chat_message_stopped covers
                // the first case; this server event also covers the other two.
                posthog.capture({
                  distinctId: input.userId,
                  event: "chat_message_aborted",
                  groups: { organization: input.organizationId },
                  properties: {
                    organization_id: input.organizationId,
                    thread_id: mem.thread.id,
                    agent_id: input.agent.id,
                    model_id: models.thinking.id,
                    mode: input.mode,
                    duration_ms: Date.now() - streamStartAt,
                    is_resume: input.isResume ?? false,
                  },
                });
                return;
              }
              console.error("[decopilot] stream error:", stringifyError(error));
              posthog.capture({
                distinctId: input.userId,
                event: "chat_message_failed",
                groups: { organization: input.organizationId },
                properties: {
                  organization_id: input.organizationId,
                  thread_id: mem.thread.id,
                  agent_id: input.agent.id,
                  model_id: models.thinking.id,
                  mode: input.mode,
                  duration_ms: Date.now() - streamStartAt,
                  error_category: classifyStreamError(error),
                  error_message:
                    error instanceof Error
                      ? error.message
                      : stringifyError(error),
                  is_resume: input.isResume ?? false,
                },
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
            },
          },
        }),
        ctx,
        mem.thread.id,
      ),
    );

    // Setup complete — hand the uiStream back to `dispatchRunAndWait`,
    // which drains it with a reader loop and resolves when the run
    // finishes. The harness does not start until that first pull (see
    // `lazyStream`). When a streamBuffer is configured the run also pumps
    // into JetStream so `/stream` tails see chunks live across runs and tabs.
    //
    // The stream is wrapped (inside the lazy factory) with a throttled
    // progress tap (Task 9): every chunk that flows out is "progress",
    // collapsed to ≤1 `last_progress_at` write per ~3s per run. The single
    // consumer downstream (pump or direct drain) pulls through this tap, so
    // the heartbeat fires regardless of which consumption path runs.
    return {
      taskId: mem.thread.id,
      uiStream,
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
 * Resolve the sandbox provisioning config for a link-transport work item.
 *
 * Mirrors the logic in `provisionSandbox` but returns the resolved config
 * instead of calling `runner.ensure`. Called from `prepareLinkWorkDispatch` for EVERY
 * harness (decopilot, claude-code, codex) targeting user-desktop so the daemon
 * can spawn the sandbox cold without a prior WS-path ensure call. Decopilot
 * desktop ALSO runs in a sandbox (Transport Convergence), so the repo/workload
 * derivation applies to it identically.
 *
 * Returns `null` when no sandbox config can be derived (non-user-desktop
 * target, or unresolvable metadata).
 */
async function resolveLinkSandboxConfig(
  input: DispatchRunInput,
  ctx: StudioContext,
  sandboxHandle: string,
): Promise<WorkItemSandbox | null> {
  if (input.target?.sandboxProviderKind !== "user-desktop") return null;

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
      const connectionId = githubRepo.connectionId;
      const { cloneUrl, gitUserName, gitUserEmail } = connectionId
        ? await (async () => {
            await ensureGithubCloneToken({
              ctx,
              connectionId,
              organizationId: input.organizationId,
              forceRefresh: true,
              onLegacyMintError: (error) => {
                console.warn(
                  "[prepareLinkWorkDispatch] repo-scoped legacy token mint failed",
                  {
                    connectionId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              },
            });
            return buildCloneInfo(
              connectionId,
              githubRepo.owner,
              githubRepo.name,
              ctx.db,
              ctx.vault,
            );
          })()
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
        `[prepareLinkWorkDispatch] failed to resolve clone info for agent=${input.agent.id}:`,
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
      `[prepareLinkWorkDispatch] failed to derive offload allowlist for agent=${input.agent.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Org-fs mounts (desktop dispatch path; this fn already returned null for
  // non-user-desktop). Mint an fs token + build ORGFS_CONFIG; guarded → no
  // mounting on failure. Mirrors SANDBOX_START's provisionSandbox.
  const orgFsConfigJson = ctx.organization?.slug
    ? await mintOrgFsConfigJson(ctx, {
        orgSlug: ctx.organization.slug,
        orgId: input.organizationId,
        baseUrl: getPublicUrl(),
      })
    : undefined;

  const operator = normalizeCoAuthorIdentity({
    userName: ctx.auth.user?.name,
    userEmail: ctx.auth.user?.email,
  });

  return {
    handle: sandboxHandle,
    ...(repo ? { repo } : {}),
    ...(workload ? { workload } : {}),
    ...(operator ? { operator } : {}),
    ...(offloadAllowedHosts !== undefined ? { offloadAllowedHosts } : {}),
    ...(offloadAllowSameHostDev !== undefined
      ? { offloadAllowSameHostDev }
      : {}),
    ...(orgFsConfigJson ? { orgFsConfigJson } : {}),
  };
}

/**
 * Prepare a user-desktop run for downstream link execution.
 *
 * Claims the run and mints the fence (via prepareRun), then returns the fence
 * token, task id, and fully assembled wire `HarnessStreamInput` for the gate
 * step to publish as a tunnel work item.
 *
 * IMPORTANT: `uiStream` from prepareRun is never consumed here. Since
 * prepareRun's stream is lazy (harness dispatch happens on first pull), the
 * local harness does NOT run for link-dispatched threads. The daemon runs it
 * remotely and the run transitions to terminal when the ingest finish handler
 * fires FINISH.
 *
 * The work item's `harnessInput` is the complete `wireHarnessInput` that
 * prepareRun builds eagerly (mcp endpoint minted, userMessage materialized,
 * workspace + fence token attached), exactly the shape the daemon validates
 * against `harnessStreamInputSchema`. The non-serializable `signal` member is
 * intentionally absent; it only exists for the hosted dispatch path.
 *
 * Also resolves the sandbox provisioning config (handle, repo clone URL,
 * workload runtime) for harnesses targeting user-desktop, so the daemon can
 * spawn the sandbox cold. Carries `orgSlug` so the daemon ingest path can
 * construct the URL without a DB lookup.
 */
export async function prepareLinkWorkDispatch(
  input: DispatchRunInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
): Promise<{
  taskId: string;
  runFenceToken: string;
  harnessInput: WireHarnessInput;
  messagesRef: MessagesRef | null;
  sandboxConfig: WorkItemSandbox | null;
  orgSlug: string;
}> {
  return traced(
    "decopilot.prepareLinkWorkDispatch",
    async (_rootSpan) => {
      const { taskId, runFenceToken, wireHarnessInput } = await prepareRun(
        input,
        ctx,
        deps,
        _rootSpan,
      );

      const effectiveHarnessInput: WireHarnessInput = wireHarnessInput;
      const messagesRef: MessagesRef | null = null;

      // Resolve the sandbox handle for the desktop work item.
      // Pure derivation — no ensure round-trip. The daemon self-ensures
      // the sandbox from `WorkItem.sandbox` when it dequeues the item
      // (`dispatchLinkWorkItem`: `input.provider.ensureSandbox(ensureInput)`),
      // so no cluster-side warm-ensure is needed (the push ensure helper was
      // deleted with the push path). The handle formula is identical to what
      // `ensureSandbox`/`provisionSandbox` would compute. See `computeDesktopSandboxHandle`.
      // Compute the sandbox config for EVERY user-desktop run (all harnesses,
      // incl. decopilot — Transport Convergence). Decopilot desktop runs in a
      // sandbox too; `resolveLinkSandboxConfig` derives the same repo/workload
      // config for it as for the CLI harnesses.
      let sandboxConfig: WorkItemSandbox | null = null;
      if (input.target?.sandboxProviderKind === "user-desktop") {
        try {
          const sandboxHandle = computeDesktopSandboxHandle({
            agentId: input.agent.id,
            userId: input.userId,
            organizationId: input.organizationId,
            branch: input.branch ?? "ephemeral",
          });
          sandboxConfig = await resolveLinkSandboxConfig(
            input,
            ctx,
            sandboxHandle,
          );
        } catch (err) {
          // Log but don't fail prepareLinkWorkDispatch — the daemon falls back to
          // ensureSandbox({ handle }) for a running sandbox, and cold spawn
          // will fail loudly on the daemon side if the config is missing.
          console.warn(
            `[prepareLinkWorkDispatch] failed to resolve sandbox config agent=${input.agent.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // The daemon is user-scoped and no longer carries a startup org, so the
      // work item MUST carry the org slug for the ingest URL. Prefer the
      // request-resolved org; fall back to a slug lookup by org id so it can
      // never be missing (the daemon has no DB access to resolve it).
      // ctx.organization is normally populated by the org-scoped route middleware
      // (/api/:org/...); the DB lookup is only a safety net for internal callers
      // that bypass that middleware (e.g. background automation).
      let orgSlug = ctx.organization?.slug ?? null;
      if (!orgSlug) {
        const orgRow = await ctx.db
          .selectFrom("organization")
          .select("slug")
          .where("id", "=", input.organizationId)
          .executeTakeFirst();
        orgSlug = orgRow?.slug ?? null;
      }
      if (!orgSlug) {
        throw new Error(
          `prepareLinkWorkDispatch: could not resolve org slug for organization ${input.organizationId}`,
        );
      }

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
 * Pure, synchronous handle derivation — no I/O, no ensure round-trip.
 *
 * Mirrors the formula used by `ensureSandbox` / `provisionSandbox`:
 *   projectRef = composeSandboxRef({ orgId, virtualMcpId: agentId, branch })
 *   handle     = computeClaimHandle({ userId, projectRef }, branch)
 *
 * This is the SAME handle the daemon receives in `WorkItem.sandbox.handle`
 * (set by `resolveLinkSandboxConfig`) and that the daemon derives via
 * `deriveHandle(item)`. Both sides agree by construction.
 *
 * Safe to call at dispatch-run sites where the daemon will self-ensure the
 * sandbox from the work item (`dispatchLinkWorkItem` calls
 * `input.provider.ensureSandbox(ensureInput)`). The warm-ensure round-trip at
 * those sites is therefore redundant and is replaced by this pure call.
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
