/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

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
import { PersistedRunConfigSchema, toModelsConfig } from "./run-config";
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage, ModelsConfig } from "./types";
import { dispatchRun, type DispatchRunInput } from "./dispatch-run";
import { enqueueThreadRun } from "@/dispatch-queue";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import type { SqlThreadStorage } from "@/storage/threads";
import type { QueuedMessagesStorage } from "@/storage/queued-messages";
import { getPodId } from "@/core/pod-identity";

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
 * ready to hand to `enqueueThreadRun` (POST /messages) or `dispatchRun`
 * (orphan-resume).
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

/**
 * Pull the user-visible text out of a ChatMessage for inbox rendering. The
 * AI-SDK UI parts have many types; we only render the text payload(s) here
 * — file attachments, tool calls, etc. don't apply to a pending message.
 */
function extractMessageText(message: ChatMessage): string {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
    ) {
      texts.push((part as { text: string }).text);
    }
  }
  return texts.join("\n");
}

/**
 * Emit the `chat_message_started` posthog event for an enqueued run.
 * Telemetry lives here (not inside `dispatchRun`) so orphan-resume and
 * automation paths — which don't represent a fresh user message — don't
 * double-count `chat_message_started`.
 */
function trackMessageStarted(input: DispatchRunInput, taskId: string): void {
  posthog.capture({
    distinctId: input.userId,
    event: "chat_message_started",
    groups: { organization: input.organizationId },
    properties: {
      organization_id: input.organizationId,
      agent_id: input.agent,
      mode: input.mode,
      thread_id: taskId,
      credential_id: input.models.credentialId,
    },
  });
}

// ============================================================================
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
  threadStorage: SqlThreadStorage;
  queuedMessagesStorage: QueuedMessagesStorage;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const {
    cancelBroadcast,
    streamBuffer,
    runRegistry,
    threadStorage,
    queuedMessagesStorage,
  } = deps;
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
  // on `GET /:org/decopilot/attach/:threadId` to receive chunks once the
  // workflow dequeues and dispatches.
  //
  // If another run on this thread is already executing, the new message
  // queues behind it and dispatches only after that run completes. Clients
  // see queued messages via the inbox endpoint and can cancel them by
  // taskId before they dequeue.
  //
  // Idempotency: when the client supplies an id on the request message,
  // the workflow ID is derived from `<threadId>:<messageId>`, so a retry
  // of the same POST collapses onto the existing workflow handle instead
  // of double-firing.

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
      const userMessage = input.messages[input.messages.length - 1];
      const queuedMessageId = userMessage?.id ?? crypto.randomUUID();
      const workflowID = `thread-run:${taskId}:${queuedMessageId}`;

      // Insert the inbox row BEFORE enqueueing. If two clients race the
      // same `(threadId, messageId)` (retry), the second insert fails on
      // PK conflict and we treat that as idempotent — the workflow
      // workflowID dedupes the run on the DBOS side too.
      try {
        await queuedMessagesStorage.insert({
          id: queuedMessageId,
          threadId: taskId,
          organizationId: input.organizationId,
          userId: input.userId,
          content: userMessage ? extractMessageText(userMessage) : "",
          workflowId: workflowID,
        });
        streamBuffer.publish(taskId, {
          type: "data-queue-enqueued",
          data: {
            type: "queue-enqueued",
            taskId: queuedMessageId,
            content: userMessage ? extractMessageText(userMessage) : "",
            createdAt: new Date().toISOString(),
          },
        });
      } catch (insertErr) {
        // Likely a PK conflict on retry; we still enqueue (DBOS will
        // collapse the duplicate workflow handle by workflowID).
        console.warn(
          "[decopilot:messages] queued_messages insert failed, continuing",
          insertErr,
        );
      }

      await enqueueThreadRun(
        {
          threadId: taskId,
          queuedMessageId,
          request: serializableRequest,
        },
        { workflowID },
      );
      trackMessageStarted(input, taskId);
      return c.json({ taskId, queuedMessageId }, 202);
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
  // Inbox Endpoints — list / cancel pending messages on the thread-gate queue
  // ============================================================================
  //
  // GET /:org/decopilot/threads/:threadId/queue
  //   Returns messages that were submitted on this thread and haven't yet
  //   been picked up by the dispatcher. Used by the chat UI to render
  //   pending bubbles above the input on tab open (initial snapshot);
  //   subsequent state changes flow as `data-queue-*` events on /attach.
  //
  // DELETE /:org/decopilot/threads/:threadId/queue/:messageId
  //   Cancels a queued message. Atomic CAS queued→cancelled, so a message
  //   that has already started dispatching can't be cancelled this way —
  //   use the existing `POST /cancel/:threadId` to stop an in-flight run.

  app.get("/:org/decopilot/threads/:threadId/queue", async (c) => {
    try {
      const { thread, organization } = await validateThreadAccess(c);
      const rows = await queuedMessagesStorage.listByThread(
        thread.id,
        organization.id,
      );
      return c.json({
        items: rows.map((r) => ({
          id: r.id,
          threadId: r.threadId,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      console.error("[decopilot:queue:list] Error", err);
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  app.delete(
    "/:org/decopilot/threads/:threadId/queue/:messageId",
    async (c) => {
      try {
        const { thread, organization } = await validateThreadOwnership(c);
        const messageId = c.req.param("messageId");
        const cancelled = await queuedMessagesStorage.cancel(
          messageId,
          organization.id,
        );
        if (!cancelled) {
          // Either already dispatched (claim won the race) or unknown id.
          return c.json({ cancelled: false }, 404);
        }
        streamBuffer.publish(thread.id, {
          type: "data-queue-cancelled",
          data: { type: "queue-cancelled", taskId: messageId },
        });
        return c.json({ cancelled: true });
      } catch (err) {
        console.error("[decopilot:queue:cancel] Error", err);
        if (err instanceof HTTPException) {
          return c.json({ error: err.message }, err.status);
        }
        return c.json({ error: "Internal error" }, 500);
      }
    },
  );

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
  // Attach Endpoint — replay JetStream-buffered stream for late-joining clients
  // ============================================================================

  app.get("/:org/decopilot/attach/:threadId", async (c) => {
    try {
      const { taskId, thread, organization } = await validateThreadAccess(c);

      const activeRun = runRegistry.isRunning(taskId);

      // The persistent connection stays open across runs — JetStream-level
      // `{done}` sentinels are skipped on the server, and clients detect
      // run boundaries from the AI-SDK `{type: "finish"}` chunk in the
      // stream. One open /attach per (tab, thread) covers every run.
      const serveTail = async (deliverPolicy: "all" | "new") => {
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
      };

      // ── Fast path: run is active on this pod → tail JetStream ──
      if (activeRun) {
        return await serveTail("all");
      }

      // ── Orphan resume path ──
      const ctx = c.get("meshContext");
      const userId = ctx.auth?.user?.id;

      // Not in_progress → no run to resume. Attach anyway from "new" so
      // the client picks up the next POST /messages on this thread
      // without having to reconnect.
      if (thread.status !== "in_progress") {
        return await serveTail("new");
      }

      // Only the thread owner can trigger orphan resume
      if (thread.created_by !== userId) {
        return c.body(null, 204);
      }

      // No persisted config → can't resume; force-fail so user can retry
      if (!thread.run_config) {
        await threadStorage.forceFailIfInProgress(taskId, organization.id);
        return c.body(null, 204);
      }

      // Validate stored config (schema drift protection)
      const parsed = PersistedRunConfigSchema.safeParse(thread.run_config);
      if (!parsed.success) {
        await threadStorage.forceFailIfInProgress(taskId, organization.id);
        return c.body(null, 204);
      }
      const config = parsed.data;

      // Diagnostic: report which optional model slots survived persistence.
      // Helps trace cases where a resumed run loses conditional tools like
      // `web_search` / `generate_image` (gated by `models.deepResearch` and
      // `models.image` in built-in-tools/index.ts). Drop once the
      // resume-tool-dropout issue is root-caused.
      console.log("[decopilot:attach] orphan resume — persisted config", {
        taskId,
        thinkingModelId: config.models.thinking.id,
        hasFast: !!config.models.fast,
        hasCoding: !!config.models.coding,
        hasImage: !!config.models.image,
        hasDeepResearch: !!config.models.deepResearch,
        mode: config.mode,
      });

      // Re-check model permissions with CURRENT user role
      const allowedModels = await fetchModelPermissions(
        ctx.db,
        organization.id,
        ctx.auth.user?.role,
      );
      if (
        allowedModels !== undefined &&
        !checkModelPermission(
          allowedModels,
          config.models.credentialId,
          config.models.thinking.id,
        )
      ) {
        throw new HTTPException(403, {
          message: "Model not allowed for your role",
        });
      }

      // Atomic CAS claim — succeeds for null or stale run_owner_pod
      const claimed = await threadStorage.claimOrphanedRun(
        taskId,
        organization.id,
        getPodId(),
      );
      if (!claimed) {
        return c.body(null, 204);
      }

      // Resume the run — identity from auth context, NOT stored config.
      // Fire-and-forget: the resumed run pumps into JetStream, and the
      // tail subscription created below is what we serve to this request.
      await dispatchRun(
        {
          messages: [],
          models: toModelsConfig(config.models),
          agent: config.agent,
          temperature: config.temperature,
          toolApprovalLevel: config.toolApprovalLevel,
          mode: config.mode,
          organizationId: organization.id,
          userId,
          taskId,
          windowSize: config.windowSize,
          isResume: true,
        },
        ctx,
        { runRegistry, streamBuffer, cancelBroadcast },
      );

      return await serveTail("all");
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:attach] Error", err);
      return c.body(null, 500);
    }
  });

  return app;
}
