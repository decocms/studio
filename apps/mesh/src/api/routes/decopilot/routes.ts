/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import { createHash } from "node:crypto";
import type { MeshContext } from "@/core/mesh-context";
import { TierUnavailableError, resolveTier } from "@/core/resolve-tier";
import { resolveAgentTier } from "@/ai-providers/agent-tiers";
import type { ChatTier, SimpleModeTier } from "@/tools/organization/schema";
import { posthog } from "@/posthog";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_WINDOW_SIZE } from "./constants";
import { splitRequestMessages } from "./conversation";
import {
  ensureOrganization,
  validateThreadAccess,
  validateThreadOwnership,
} from "./helpers";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { StreamBuffer } from "./stream-buffer";
import type { RunRegistry } from "./run-registry";
import {
  checkModelPermission,
  fetchModelPermissions,
  parseModelsToMap,
} from "./model-permissions";
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage, ModelsConfig } from "./types";
import type { DispatchRunInput } from "./dispatch-run";
import { resolveHarnessId } from "./dispatch-run";
import { enqueueThreadRun } from "@/dispatch-queue";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import type { LinkRegistry } from "../../../links/link-registry";
import { resolveDispatchTarget } from "../../../links/resolve-dispatch-target";
import { ensureVm } from "@/tools/vm/start";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import { resolveDefaultSandboxProviderKind } from "@/sandbox/resolve-default-provider-kind";
import type { HarnessId } from "@/harnesses";

// ============================================================================
// Idempotency
// ============================================================================

/**
 * Derive the workflowID idempotency key from the last request message.
 *
 * - User messages have a fresh id per turn, so the id itself is unique.
 * - Assistant messages are re-POSTed with the same id across approval /
 *   tool-output rounds in a single logical turn. Hashing the serialized
 *   message makes each round produce a distinct key while still letting
 *   a genuine network retry of an identical POST collapse onto the same
 *   workflow.
 */
export function computeIdempotencyKey(
  lastMsg: ChatMessage | undefined,
): string | undefined {
  if (!lastMsg) return undefined;
  if (lastMsg.role === "user" && lastMsg.id) return lastMsg.id;
  return createHash("sha1").update(JSON.stringify(lastMsg)).digest("hex");
}

// ============================================================================
// Request Validation
// ============================================================================

async function validateRequest(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
) {
  const organization = ensureOrganization(c);
  const rawPayload = await c.req.json();

  const parseResult = StreamRequestSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    throw new HTTPException(400, { message: parseResult.error.message });
  }

  const { messages: rawMessages, ...rest } = parseResult.data;
  const msgs = rawMessages as unknown as ChatMessage[];
  const { systemMessages, requestMessage } = splitRequestMessages(msgs);

  return {
    organization,
    systemMessages,
    requestMessage,
    ...rest,
  };
}

/**
 * Look up the providerId for the credential the request would use, so
 * POST /messages can pick the right harness (and therefore the right
 * link capability) before enqueuing onto the thread gate. Returns
 * undefined when the credential row isn't found — the caller falls back
 * to "decopilot" (matches the existing prepareRun behavior).
 */
async function resolveProviderId(
  ctx: MeshContext,
  credentialId: string,
  organizationId: string,
): Promise<string | undefined> {
  try {
    const row = await ctx.storage.aiProviderKeys.findById(
      credentialId,
      organizationId,
    );
    return row?.providerId;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Per-Request Model Resolution
// ============================================================================

function toModelInfo(resolved: Awaited<ReturnType<typeof resolveTier>>) {
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
 * Try to resolve a tier without failing the whole request. Returns null when
 * the tier is unconfigured + has no curated default — used for optional
 * auxiliary tiers (image, web_research) where missing-credentials should
 * disable the corresponding tool, not 400 the chat request.
 */
async function tryResolveTier(ctx: MeshContext, tier: SimpleModeTier) {
  try {
    return await resolveTier(ctx, tier);
  } catch (err) {
    if (err instanceof TierUnavailableError) return null;
    console.warn(`[decopilot] tier "${tier}" resolution failed:`, err);
    return null;
  }
}

/**
 * Resolves a tier (defaulting to "smart") to a full ModelsConfig.
 *
 * Two paths:
 *
 * - **Decopilot:** goes through `resolveTier()`, which consults the org's
 *   AI provider keys + simple-mode slot configuration. Also resolves
 *   `image` and `web_research` tiers — when present they enable the
 *   `generate_image` and `web_search` built-in tools.
 *
 * - **Desktop-CLI harnesses (`claude-code`, `codex`):** the model lives
 *   on the user's desktop, not in any AI provider key. We synthesize the
 *   ModelsConfig from the agent's hardcoded tier map (`agent-tiers.ts`).
 *   The `credentialId` is a sentinel — the harness reads `models.thinking.id`
 *   to know which CLI sub-command to invoke and ignores the credential.
 *   `image` / `web_research` are not supported in this path; the
 *   corresponding built-in tools stay unregistered.
 */
async function resolvePerRequestModels(
  ctx: MeshContext,
  tier: SimpleModeTier | undefined,
  harnessId: HarnessId | null | undefined,
): Promise<ModelsConfig> {
  if (harnessId === "claude-code" || harnessId === "codex") {
    const chatTier: ChatTier =
      tier === "fast" || tier === "smart" || tier === "thinking"
        ? tier
        : "smart";
    const entry = resolveAgentTier(harnessId, chatTier);
    if (!entry) {
      // Should be unreachable — resolveAgentTier returns non-null for
      // both supported CLI harnesses and every ChatTier value.
      throw new Error(
        `No model mapping for harness "${harnessId}" tier "${chatTier}"`,
      );
    }
    return {
      credentialId: `desktop:${harnessId}`,
      thinking: {
        id: entry.modelId,
        title: entry.label,
        provider: harnessId,
      },
    };
  }

  const [chat, image, webResearch] = await Promise.all([
    resolveTier(ctx, tier ?? "smart"),
    tryResolveTier(ctx, "image"),
    tryResolveTier(ctx, "web_research"),
  ]);
  return {
    credentialId: chat.credentialId,
    thinking: toModelInfo(chat),
    ...(image ? { image: toModelInfo(image) } : {}),
    ...(webResearch ? { deepResearch: toModelInfo(webResearch) } : {}),
  };
}

// ============================================================================
// Shared validate path
// ============================================================================

/**
 * Parse + permission-check an HTTP request into a `DispatchRunInput`
 * ready to hand to `enqueueThreadRun` (POST /messages).
 *
 * Pure-ish: reads `c` for the request body and auth context, but no
 * downstream side effects. Throws `HTTPException` / `TierUnavailableError`
 * for caller-visible problems.
 *
 * When `threadIdParam` is provided (e.g. from a URL path like
 * `/threads/:threadId/...`) the body's `thread_id` must match — rejecting
 * a body that disagrees rather than silently overriding either side.
 * Legacy callers that supply the id in the body alone are unaffected.
 */
async function validate(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
  threadIdParam: string | undefined,
): Promise<
  DispatchRunInput & {
    sandboxProviderKind?: SandboxProviderKind | null;
    harnessId?: HarnessId | null;
  }
> {
  const ctx = c.get("meshContext");

  const {
    organization,
    tier,
    agent,
    systemMessages,
    requestMessage,
    temperature,
    memory: memoryConfig,
    thread_id,
    branch,
    toolApprovalLevel,
    mode,
    sandboxProviderKind,
    harnessId,
  } = await validateRequest(c);

  const bodyThreadId = thread_id ?? memoryConfig?.thread_id;
  if (threadIdParam && bodyThreadId && bodyThreadId !== threadIdParam) {
    throw new HTTPException(400, {
      message: "threadId in URL does not match thread_id in body",
    });
  }
  const taskIdInput = threadIdParam ?? bodyThreadId;

  const userId = ctx.auth?.user?.id;
  if (!userId) {
    throw new HTTPException(401, { message: "User ID is required" });
  }

  const models = await resolvePerRequestModels(ctx, tier, harnessId);

  const allowedModels = await fetchModelPermissions(
    ctx.db,
    organization.id,
    ctx.auth.user?.role,
  );
  if (
    allowedModels !== undefined &&
    !checkModelPermission(
      allowedModels,
      models.credentialId,
      models.thinking.id,
    )
  ) {
    throw new HTTPException(403, {
      message: "Model not allowed for your role",
    });
  }

  return {
    messages: [...systemMessages, requestMessage],
    models,
    agent,
    temperature,
    toolApprovalLevel,
    mode,
    organizationId: organization.id,
    userId,
    taskId: taskIdInput,
    windowSize: memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE,
    branch: branch ?? null,
    sandboxProviderKind: sandboxProviderKind ?? null,
    harnessId: harnessId ?? null,
  };
}

// ============================================================================
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
  /**
   * Used to resolve the user's link daemon. POST /messages calls
   * `resolveDispatchTarget` against this registry before enqueuing onto
   * the thread gate so the cluster can reject early with 409 instead of
   * silently queueing a run that would have nowhere to go.
   */
  linkRegistry: LinkRegistry;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const { cancelBroadcast, streamBuffer, runRegistry, linkRegistry } = deps;
  const app = new Hono<{ Variables: { meshContext: MeshContext } }>();

  // ============================================================================
  // Allowed Models Endpoint
  // ============================================================================

  app.get("/:org/decopilot/allowed-models", async (c) => {
    try {
      const ctx = c.get("meshContext");
      const organization = ensureOrganization(c);
      const role = ctx.auth.user?.role;

      const models = await fetchModelPermissions(ctx.db, organization.id, role);

      return c.json(parseModelsToMap(models));
    } catch (err) {
      console.error("[decopilot:allowed-models] Error", err);
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      );
    }
  });

  // ============================================================================
  // Messages Endpoint — enqueue a run on the per-thread gate queue
  // ============================================================================
  //
  // POST /:org/decopilot/threads/:threadId/messages
  //
  // Enqueues the run on `threadGateWorkflow` (partition=threadId,
  // concurrency=1) and returns `202 { taskId }` in milliseconds. The
  // response carries no SSE body — the client is expected to be listening
  // on `GET /:org/decopilot/threads/:threadId/stream` to receive chunks once the
  // workflow dequeues and dispatches.
  //
  // If another run on this thread is already executing, the new message
  // queues behind it and dispatches only after that run completes.
  //
  // Idempotency: a retried POST collapses onto the existing workflow
  // handle. The key is derived from the last message:
  //   - user turn: the message id (unique per turn).
  //   - approval / tool-output continuation: SHA1 of the serialized
  //     message. The assistant message id is reused across approval
  //     rounds in the same logical turn, so the id alone would dedupe
  //     two distinct accepts onto the first workflow and leave the
  //     second round's state unsaved (bricked approval prompt). Hashing
  //     the message contents gives each round a fresh workflowID while
  //     still collapsing genuine network retries of the same POST.

  app.post("/:org/decopilot/threads/:threadId/messages", async (c) => {
    try {
      const ctx = c.get("meshContext");
      const input = await validate(c, c.req.param("threadId"));
      const taskId = input.taskId;
      if (!taskId) {
        // validate() always sets taskId from the URL param, so this is
        // a structural invariant rather than a user-facing error.
        throw new HTTPException(400, { message: "threadId is required" });
      }

      // Resolve the dispatch target up-front so we can reject a
      // request with 409 *before* enqueuing it onto the thread gate.
      // Holding the link-online decision at POST time also keeps DBOS
      // replay from rerouting the run if the daemon disconnects between
      // enqueue and dispatch (the workflow body reads target directly off
      // the serialized request).
      //
      // The thread row's (sandbox_provider_kind, harness_id) are the
      // single source of truth for routing. Tolerate storage failure when
      // loading the thread row — a missing/erroring row just means we fall
      // back to the request body / default helpers (the canonical thread row
      // is created by COLLECTION_THREADS_CREATE before the first POST, but
      // legacy callers and tests may skip it).
      let existingThread: Awaited<
        ReturnType<typeof ctx.storage.threads.get>
      > | null = null;
      try {
        existingThread = (await ctx.storage.threads?.get?.(taskId)) ?? null;
      } catch {
        existingThread = null;
      }

      // Fall back to the "ephemeral" synthetic branch when neither the
      // thread row nor the request body pins one. Synthetic branches
      // (see packages/sandbox/daemon/constants.ts:isSyntheticBranch) are
      // accepted by the daemon as vmMap routing keys but never checked
      // out — exactly the right semantics for Decopilot threads on
      // agents with no clonable repo, where the branch is purely an
      // isolation key.
      const branch = existingThread?.branch ?? input.branch ?? "ephemeral";
      const branchWasDefaulted = !existingThread?.branch && !input.branch;

      // Determine the pinned (kind, harness). If the thread row has them,
      // use those. Otherwise this is the first message — derive defaults and
      // persist to the thread row.
      let pinnedKind = (existingThread?.sandbox_provider_kind ??
        null) as SandboxProviderKind | null;

      const providerId = await resolveProviderId(
        ctx,
        input.models.credentialId,
        input.organizationId,
      );
      const credentialHarness = resolveHarnessId(providerId);

      let pinnedHarness = (existingThread?.harness_id ??
        null) as HarnessId | null;

      if (!pinnedKind || !pinnedHarness || branchWasDefaulted) {
        pinnedKind =
          pinnedKind ??
          input.sandboxProviderKind ??
          (await resolveDefaultSandboxProviderKind(input.userId, {
            linkRegistry,
            resolveEnvKind: resolveSandboxProviderKindFromEnv,
          }));
        pinnedHarness = pinnedHarness ?? input.harnessId ?? credentialHarness;

        if (existingThread) {
          try {
            await ctx.storage.threads?.update?.(taskId, {
              sandbox_provider_kind: pinnedKind,
              harness_id: pinnedHarness,
              ...(branchWasDefaulted ? { branch } : {}),
            });
          } catch (err) {
            console.warn(
              "[decopilot:messages] failed to persist thread pins",
              err,
            );
          }
        }
      }

      const vm = await ensureVm(
        {
          virtualMcpId: input.agent.id,
          branch,
          sandboxProviderKind: pinnedKind,
        },
        ctx,
      );

      const target = await resolveDispatchTarget(
        { harnessId: pinnedHarness, vm, userId: input.userId },
        { linkRegistry },
      );
      if (target.kind === "error") {
        return c.json(
          {
            error: "link_unavailable",
            code: target.reason,
            activeCapabilities: target.activeCapabilities,
          },
          409,
        );
      }

      const { abortSignal: _ignored, ...rest } = input;
      const serializableRequest = {
        ...rest,
        target,
        harnessId: pinnedHarness,
      };
      const lastMsg = input.messages[input.messages.length - 1];
      const idempotencyKey = computeIdempotencyKey(lastMsg);
      const workflowID = idempotencyKey
        ? `thread-run:${taskId}:${idempotencyKey}`
        : undefined;

      // The workflow body emits `chat_message_started` inside a DBOS step,
      // so idempotent retries that collapse onto an existing workflowID
      // don't double-count in PostHog. Don't add a duplicate emit here.
      await enqueueThreadRun(
        {
          threadId: taskId,
          request: serializableRequest,
          source: "user-message",
        },
        { workflowID },
      );
      return c.json({ taskId }, 202);
    } catch (err) {
      console.error("[decopilot:messages] Error", err);
      if (err instanceof TierUnavailableError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      posthog.captureException(err);
      return c.json(
        { error: err instanceof Error ? err.message : JSON.stringify(err) },
        500,
      );
    }
  });

  // ============================================================================
  // Cancel Endpoint — cancel ongoing run (local or via NATS to owning pod)
  // ============================================================================

  app.post("/:org/decopilot/cancel/:threadId", async (c) => {
    const { taskId, thread, organization } = await validateThreadOwnership(c);

    // Try to cancel locally first
    const cancelTransitions = await runRegistry.execute({
      type: "CANCEL",
      taskId,
    });
    if (cancelTransitions.some((t) => t.event.type === "RUN_FAILED")) {
      return c.json({ cancelled: true });
    }

    // Not on this pod — broadcast to all pods
    cancelBroadcast.broadcast(taskId);

    // Ghost run: server restarted while a run was in progress. No pod has this
    // run in memory, so the broadcast will never resolve. Force-fail the thread
    // in the DB so the user can send new messages.
    if (thread.status === "in_progress") {
      console.warn("[decopilot:cancel] Ghost run detected, force-failing", {
        taskId,
      });
      runRegistry
        .execute({
          type: "FORCE_FAIL",
          taskId,
          reason: "ghost",
          orgId: organization.id,
        })
        .catch((err) => {
          console.error(
            "[decopilot:cancel] Failed to force-fail ghost thread",
            {
              taskId,
              err,
            },
          );
        });
    }

    return c.json({ cancelled: true, async: true }, 202);
  });

  // ============================================================================
  // Stream Endpoint — tail the per-thread JetStream subject
  // ============================================================================
  //
  // Pure live tail. The client owns initial message state via the
  // `COLLECTION_THREAD_MESSAGES_LIST` MCP tool and re-fetches the latest
  // page on every reconnect; this endpoint serves only live UI message
  // chunks from the JetStream subject. The persistent connection stays
  // open across runs — clients detect run boundaries from the AI-SDK
  // `{type: "finish"}` chunk. One open stream per (tab, thread) covers
  // every run.
  //
  // Recovery for in-flight runs whose owning pod died is handled out of
  // band: the thread-gate workflow step is restarted by the DBOS recovery
  // executor on a healthy pod, and the heartbeat watcher in `app.ts`
  // resurrects orphaned runs explicitly. Either way, chunks land back on
  // this thread's JetStream subject and the existing stream tail picks
  // them up — no client-triggered resume is needed here.

  app.get("/:org/decopilot/threads/:threadId/stream", async (c) => {
    try {
      const { taskId, thread } = await validateThreadAccess(c);

      // Use the DB's view, not pod-local registry state. A client attached
      // to a non-owner pod (any multi-pod deployment, including mid-deploy
      // and after a DBOS replay rehome) needs `"all"` to catch chunks the
      // owning pod has already pumped to the shared JetStream subject.
      // The buffer is purged on terminal events (run-reactor), so `"all"`
      // only ever replays the current in-flight run.
      const deliverPolicy = thread.status === "in_progress" ? "all" : "new";
      const tailChunkStream = await streamBuffer.createTailStream(
        taskId,
        c.req.raw.signal,
        { deliverPolicy },
      );
      if (!tailChunkStream) {
        return c.body(null, 204);
      }

      const tailStream = createUIMessageStream({
        execute: async ({ writer }) => {
          const reader = tailChunkStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              writer.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        },
      });

      const baseResponse = createUIMessageStreamResponse({
        stream: tailStream,
        consumeSseStream: consumeStream,
      });

      return wrapWithSseKeepalive(baseResponse);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:stream] Error", err);
      return c.body(null, 500);
    }
  });

  return app;
}
