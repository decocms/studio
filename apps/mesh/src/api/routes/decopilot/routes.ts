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
import { streamCore } from "./stream-core";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import type { SqlThreadStorage } from "@/storage/threads";
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
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
  threadStorage: SqlThreadStorage;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const { cancelBroadcast, streamBuffer, runRegistry, threadStorage } = deps;
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
  // Stream Endpoint (legacy — request-response shape)
  // ============================================================================
  //
  // DEPRECATED. Use `POST /:org/decopilot/threads/:threadId/messages`
  // (fire-and-forget) + `GET /:org/decopilot/attach/:threadId?persistent=true`
  // (long-lived subscription) instead. Kept for backwards compatibility
  // with the existing chat hook until it migrates.
  //
  // Internally now identical to the subscribe model: streamCore starts the
  // pump, then we open a one-shot tail subscription on the same JetStream
  // subject and serve it as SSE. This means even legacy clients survive
  // proxy/tab-close cuts cleanly (next /attach hits a hot JetStream tail).

  app.post("/:org/decopilot/stream", async (c) => {
    try {
      const ctx = c.get("meshContext");

      // 1. Validate request
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

      const userId = ctx.auth?.user?.id;
      if (!userId) {
        throw new HTTPException(401, { message: "User ID is required" });
      }

      // 2. Resolve the request's tier to a concrete (credentialId, modelId).
      const models = await resolvePerRequestModels(ctx, tier);

      // 3. Check model permissions
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

      const windowSize = memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE;
      const resolvedThreadId = thread_id ?? memoryConfig?.thread_id;

      // 4. Delegate to streamCore
      const result = await streamCore(
        {
          messages: [...systemMessages, requestMessage],
          models,
          agent,
          temperature,
          toolApprovalLevel,
          mode,
          organizationId: organization.id,
          userId,
          taskId: resolvedThreadId,
          windowSize,
          branch: branch ?? null,
        },
        ctx,
        { runRegistry, streamBuffer, cancelBroadcast },
      );

      posthog.capture({
        distinctId: userId,
        event: "chat_message_started",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          agent_id: agent,
          mode,
          thread_id: resolvedThreadId,
          credential_id: models.credentialId,
        },
      });

      // streamCore started the pump. Create a one-shot tail subscription
      // (closes on the {done} sentinel) so this request returns SSE chunks
      // for the just-started run, then completes when the run ends.
      const tailChunkStream = await streamBuffer.createTailStream(
        result.taskId,
        c.req.raw.signal,
      );
      if (!tailChunkStream) {
        return c.json(
          { error: "Stream buffer unavailable — cannot serve response" },
          503,
        );
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
      console.error("[decopilot:stream] Error", err);

      if (err instanceof TierUnavailableError) {
        return c.json({ error: err.message }, 400);
      }

      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }

      if (err instanceof Error && err.name === "AbortError") {
        console.warn("[decopilot:stream] Aborted", { error: err.message });
        return c.json({ error: "Request aborted" }, 400);
      }

      posthog.captureException(err);
      console.error("[decopilot:stream] Failed", {
        error: err instanceof Error ? err.message : JSON.stringify(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return c.json(
        { error: err instanceof Error ? err.message : JSON.stringify(err) },
        500,
      );
    }
  });

  // ============================================================================
  // Messages Endpoint — fire-and-forget run creation (subscribe model)
  // ============================================================================
  //
  // POST /:org/decopilot/threads/:threadId/messages
  //
  // Subscribe-model command: claims the run, starts the JetStream pump,
  // and returns `202 { taskId }` in milliseconds. The response carries no
  // SSE body — the client is expected to be listening on
  // `GET /:org/decopilot/attach/:threadId?persistent=true` (or any
  // /attach connection it opened earlier) to receive the run's chunks.
  //
  // This decouples message submission from the long-lived stream
  // connection, so a slow proxy / tab close / mobile network blip on the
  // subscribe side never affects the producer, and multiple clients can
  // observe the same thread without coordinating.
  //
  // The threadId is required in the URL — unlike legacy /stream which
  // accepted it in the body — because in the subscribe model the thread
  // is the addressable resource.

  app.post("/:org/decopilot/threads/:threadId/messages", async (c) => {
    try {
      const ctx = c.get("meshContext");
      const threadIdParam = c.req.param("threadId");

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

      // URL path is the source of truth for threadId in this endpoint.
      // Reject mismatches rather than silently overriding either side.
      const bodyThreadId = thread_id ?? memoryConfig?.thread_id;
      if (bodyThreadId && bodyThreadId !== threadIdParam) {
        throw new HTTPException(400, {
          message: "threadId in URL does not match thread_id in body",
        });
      }

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

      const windowSize = memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE;

      const { taskId } = await streamCore(
        {
          messages: [...systemMessages, requestMessage],
          models,
          agent,
          temperature,
          toolApprovalLevel,
          mode,
          organizationId: organization.id,
          userId,
          taskId: threadIdParam,
          windowSize,
          branch: branch ?? null,
        },
        ctx,
        { runRegistry, streamBuffer, cancelBroadcast },
      );

      posthog.capture({
        distinctId: userId,
        event: "chat_message_started",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          agent_id: agent,
          mode,
          thread_id: taskId,
          credential_id: models.credentialId,
        },
      });

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
  // Attach Endpoint — replay JetStream-buffered stream for late-joining clients
  // ============================================================================

  app.get("/:org/decopilot/attach/:threadId", async (c) => {
    try {
      const { taskId, thread, organization } = await validateThreadAccess(c);

      // Subscribe model: `?persistent=true` keeps the connection open across
      // runs in this thread. The default (no query param) closes when the
      // current run emits its `{done}` sentinel — matches legacy /attach
      // reconnect semantics for clients that haven't migrated yet.
      const persistent = c.req.query("persistent") === "true";
      const activeRun = runRegistry.isRunning(taskId);

      const serveTail = async (deliverPolicy: "all" | "new") => {
        const tailChunkStream = await streamBuffer.createTailStream(
          taskId,
          c.req.raw.signal,
          { closeOnDone: !persistent, deliverPolicy },
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

      // Not in_progress → no run to resume. In persistent mode, attach
      // anyway and wait for a future POST /messages on this thread.
      if (thread.status !== "in_progress") {
        if (persistent) {
          return await serveTail("new");
        }
        return c.body(null, 204);
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
      await streamCore(
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
