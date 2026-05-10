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
import { RunClaimError } from "./run-reactor";
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

/**
 * Resolves a tier (defaulting to "smart") to a full ModelsConfig via the
 * shared resolveTier(), which falls back to curated provider defaults when
 * the org's tier slot is unset.
 */
async function resolvePerRequestModels(
  ctx: MeshContext,
  tier: SimpleModeTier | undefined,
): Promise<ModelsConfig> {
  const resolved = await resolveTier(ctx, tier ?? "smart");
  return {
    credentialId: resolved.credentialId,
    thinking: {
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
              text:
                resolved.modelMeta.capabilities.includes("text") || undefined,
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
    },
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
  // Stream Endpoint
  // ============================================================================

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

      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: result.stream,
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

  app.post("/:org/decopilot/runtime/stream", async (c) => {
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

      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: result.stream,
          consumeSseStream: consumeStream,
        }),
      );
    } catch (err) {
      console.error("[decopilot:stream] Error", err);

      if (err instanceof RunClaimError) {
        return c.json({ error: err.message }, 409);
      }

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

      // ── Fast path: run is active on this pod → replay buffer ──
      if (runRegistry.isRunning(taskId)) {
        const replayChunkStream = await streamBuffer.createReplayStream(taskId);
        if (!replayChunkStream) {
          return c.body(null, 204);
        }

        const replayStream = createUIMessageStream({
          execute: async ({ writer }) => {
            const reader = replayChunkStream.getReader();
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
            stream: replayStream,
            consumeSseStream: consumeStream,
          }),
        );
      }

      // ── Orphan resume path ──
      const ctx = c.get("meshContext");
      const userId = ctx.auth?.user?.id;

      // Not in_progress → nothing to resume
      if (thread.status !== "in_progress") {
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

      // Resume the run — identity from auth context, NOT stored config
      const result = await streamCore(
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

      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: result.stream,
          consumeSseStream: consumeStream,
        }),
      );
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:attach] Error", err);
      return c.body(null, 500);
    }
  });

  return app;
}
