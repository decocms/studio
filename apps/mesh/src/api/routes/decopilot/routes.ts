/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import { createHash } from "node:crypto";
import type { MeshContext } from "@/core/mesh-context";
import {
  TierUnavailableError,
  resolveTier,
  tryResolveTier,
} from "@/core/resolve-tier";
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
  filterToolTiersByPermission,
  parseModelsToMap,
} from "./model-permissions";
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage, ModelsConfig } from "./types";
import type { DispatchRunInput } from "./dispatch-run";
import { resolveHarnessId } from "./dispatch-run";
import { enqueueThreadRun } from "@/dispatch-queue";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import type { LinkClaimRegistry } from "../../../links/link-claim-registry";
import { resolveDispatchTarget } from "../../../links/resolve-dispatch-target";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import { resolveDefaultSandboxProviderKind } from "@/sandbox/resolve-default-provider-kind";
import type { HarnessId } from "@/harnesses";
import type { Thread } from "@/storage/types";

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
 * Resolves a tier (defaulting to "smart") to a full ModelsConfig via the
 * shared resolveTier(), which falls back to curated provider defaults when
 * the org's tier slot is unset. Also resolves the "image" and "web_research"
 * tiers — when present they enable the generate_image and web_search
 * built-in tools (registration is conditional in built-in-tools/index.ts).
 *
 * Exported so server-initiated dispatch paths (e.g. preset-task /start)
 * can compose a ModelsConfig the same way HTTP chat does, instead of
 * duplicating the tier-resolution + tryResolve fallback logic.
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

// ============================================================================
// Shared validate path
// ============================================================================

/**
 * Resolve the effective (harnessId, sandboxProviderKind, branch) for a
 * dispatch, given the values the client supplied and the (possibly
 * locked) thread row.
 *
 * Once a thread row carries a non-null `harness_id`, the thread's
 * runtime is pinned for life: the row's values win and any
 * client-provided override is silently dropped. If the row is unlocked
 * (`harness_id == null`) or there's no thread at all (first message of
 * a freshly-created thread, or `taskIdInput === undefined`) we fall
 * back to the client values.
 *
 * Exported so the guard can be unit-tested without standing up the rest
 * of `validate()` (model resolution, permission checks, Hono context).
 *
 * See spec:
 * docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
 */
export function applyThreadLock(args: {
  taskIdInput: string | undefined;
  thread: Pick<
    Thread,
    "harness_id" | "sandbox_provider_kind" | "branch"
  > | null;
  requestedHarnessId: HarnessId | null | undefined;
  requestedSandboxProviderKind: SandboxProviderKind | null | undefined;
  requestedBranch: string | null | undefined;
}): {
  harnessId: HarnessId | null | undefined;
  sandboxProviderKind: SandboxProviderKind | null | undefined;
  branch: string | null | undefined;
  locked: boolean;
} {
  const {
    taskIdInput,
    thread,
    requestedHarnessId,
    requestedSandboxProviderKind,
    requestedBranch,
  } = args;

  if (!taskIdInput || !thread?.harness_id) {
    return {
      harnessId: requestedHarnessId,
      sandboxProviderKind: requestedSandboxProviderKind,
      branch: requestedBranch,
      locked: false,
    };
  }

  if (requestedHarnessId && requestedHarnessId !== thread.harness_id) {
    console.warn(
      "decopilot.submit: ignored harness override on locked thread",
      {
        threadId: taskIdInput,
        requested: requestedHarnessId,
        locked: thread.harness_id,
      },
    );
  }

  return {
    harnessId: thread.harness_id as HarnessId,
    sandboxProviderKind:
      (thread.sandbox_provider_kind as SandboxProviderKind | null) ?? undefined,
    branch: thread.branch ?? null,
    locked: true,
  };
}

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

  // Lock guard: once a thread row carries a non-null `harness_id`, the
  // thread's runtime (harness, sandbox provider, branch) is pinned for
  // life. Any client-provided override is silently dropped, and the
  // per-request model resolution below uses the locked harness so we
  // never dispatch with mismatched (harness, models).
  //
  // See spec:
  // docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
  const lockedThread = taskIdInput
    ? await ctx.storage.threads.get(taskIdInput)
    : null;
  const {
    harnessId: effectiveHarnessId,
    sandboxProviderKind: effectiveSandboxProviderKind,
    branch: effectiveBranch,
  } = applyThreadLock({
    taskIdInput,
    thread: lockedThread,
    requestedHarnessId: harnessId,
    requestedSandboxProviderKind: sandboxProviderKind,
    requestedBranch: branch,
  });

  const resolvedModels = await resolvePerRequestModels(
    ctx,
    tier,
    effectiveHarnessId,
  );

  const allowedModels = await fetchModelPermissions(
    ctx.db,
    organization.id,
    ctx.auth.user?.role,
  );
  if (
    allowedModels !== undefined &&
    !checkModelPermission(
      allowedModels,
      resolvedModels.credentialId,
      resolvedModels.thinking.id,
    )
  ) {
    throw new HTTPException(403, {
      message: "Model not allowed for your role",
    });
  }
  // Silently drop tool tiers (image, deepResearch) that resolve to a key
  // the user's role can't access — otherwise an admin-set tier slot would
  // grant restricted users implicit access to the underlying credential
  // via generate_image / web_search.
  const models = filterToolTiersByPermission(allowedModels, resolvedModels);

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
    branch: effectiveBranch ?? null,
    sandboxProviderKind: effectiveSandboxProviderKind ?? null,
    harnessId: effectiveHarnessId ?? null,
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
  linkClaimRegistry: LinkClaimRegistry;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const { cancelBroadcast, streamBuffer, runRegistry, linkClaimRegistry } =
    deps;
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
      // accepted by the daemon as sandboxMap routing keys but never checked
      // out — exactly the right semantics for Decopilot threads on
      // agents with no clonable repo, where the branch is purely an
      // isolation key.
      const branch = existingThread?.branch ?? input.branch ?? "ephemeral";

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

      if (!pinnedKind || !pinnedHarness) {
        pinnedKind =
          pinnedKind ??
          input.sandboxProviderKind ??
          (await resolveDefaultSandboxProviderKind(input.userId, {
            linkClaimRegistry,
            resolveEnvKind: resolveSandboxProviderKindFromEnv,
          }));
        pinnedHarness = pinnedHarness ?? input.harnessId ?? credentialHarness;

        if (existingThread) {
          try {
            // Persist `branch` unconditionally on the initial pin write so
            // the thread row is the single source of truth the lock guard
            // (validate() / applyThreadLock) reads on every follow-up.
            // Previously we only stored the synthetic "ephemeral" fallback
            // (`branchWasDefaulted` path); a user who explicitly picked
            // "main" on the first message would have it dropped here, and
            // the lock would later resolve to null and dispatch against
            // "ephemeral" instead. The lock contract (spec
            // 2026-06-03-lock-thread-harness-and-branch-design.md) says
            // all three locked fields are pinned together — branch is no
            // exception.
            await ctx.storage.threads?.update?.(taskId, {
              sandbox_provider_kind: pinnedKind,
              harness_id: pinnedHarness,
              branch,
            });
          } catch (err) {
            console.warn(
              "[decopilot:messages] failed to persist thread pins",
              err,
            );
          }
        }
      }

      // `resolveDispatchTarget` only needs the resolved `sandboxProviderKind`
      // — we pass it directly instead of provisioning a VM here. VM
      // provisioning happens lazily inside the built-in tools layer
      // (`apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts`'s
      // `ensureHandle`) on the first VM-tool invocation. Eagerly calling
      // `ensureSandbox` at POST time used to fail in environments without a
      // link daemon for the user even when the run never touches the
      // sandbox (e.g. CI multi-pod tests that drive only the mock AI
      // provider).
      const result = await resolveDispatchTarget(
        {
          harnessId: pinnedHarness,
          sandboxProviderKind: pinnedKind,
          userId: input.userId,
        },
        { linkClaimRegistry },
      );
      if (!result.ok) {
        return c.json(
          {
            error: "link_unavailable",
            code: result.error.kind,
            activeCapabilities:
              result.error.kind === "user_desktop_link_capability_missing"
                ? result.error.activeCapabilities
                : undefined,
          },
          409,
        );
      }
      const target = result.target;

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
