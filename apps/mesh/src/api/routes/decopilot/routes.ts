/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import { createHash } from "node:crypto";
import type { MeshContext } from "@/core/mesh-context";
import { TierUnavailableError, resolveTier } from "@/core/resolve-tier";
import type { SimpleModeTier } from "@/tools/organization/schema";
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
import { enqueueThreadRun } from "@/dispatch-queue";
import { wrapWithSseKeepalive } from "./sse-keepalive";

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
 * Resolves a tier (defaulting to "smart") to a full ModelsConfig via the
 * shared resolveTier(), which falls back to curated provider defaults when
 * the org's tier slot is unset. Also resolves the "image" and "web_research"
 * tiers — when present they enable the generate_image and web_search
 * built-in tools (registration is conditional in built-in-tools/index.ts).
 */
async function resolvePerRequestModels(
  ctx: MeshContext,
  tier: SimpleModeTier | undefined,
): Promise<ModelsConfig> {
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
): Promise<DispatchRunInput> {
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

  const models = await resolvePerRequestModels(ctx, tier);

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
  };
}

// ============================================================================
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const { cancelBroadcast, streamBuffer, runRegistry } = deps;
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
      const input = await validate(c, c.req.param("threadId"));
      const taskId = input.taskId;
      if (!taskId) {
        // validate() always sets taskId from the URL param, so this is
        // a structural invariant rather than a user-facing error.
        throw new HTTPException(400, { message: "threadId is required" });
      }

      const { abortSignal: _ignored, ...serializableRequest } = input;
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
  // Pure watch endpoint. The persistent connection stays open across runs —
  // JetStream-level `{done}` sentinels are skipped on the server, and
  // clients detect run boundaries from the AI-SDK `{type: "finish"}` chunk
  // in the stream. One open stream per (tab, thread) covers every run.
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

      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: tailStream,
          consumeSseStream: consumeStream,
        }),
      );
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:stream] Error", err);
      return c.body(null, 500);
    }
  });

  return app;
}
