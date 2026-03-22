/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import type { MeshContext } from "@/core/mesh-context";
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
import type { ChatMessage } from "./types";
import { streamCore } from "./stream-core";
import type { SqlThreadStorage } from "@/storage/threads";
import { POD_ID } from "@/core/pod-identity";

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
        models,
        agent,
        systemMessages,
        requestMessage,
        temperature,
        memory: memoryConfig,
        thread_id,
        toolApprovalLevel,
      } = await validateRequest(c);

      const userId = ctx.auth?.user?.id;
      if (!userId) {
        throw new HTTPException(401, { message: "User ID is required" });
      }

      // 2. Check model permissions
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

      // 3. Delegate to streamCore
      const result = await streamCore(
        {
          messages: [...systemMessages, requestMessage],
          models,
          agent,
          temperature,
          toolApprovalLevel,
          organizationId: organization.id,
          userId,
          threadId: resolvedThreadId,
          windowSize,
        },
        ctx,
        { runRegistry, streamBuffer, cancelBroadcast },
      );

      return createUIMessageStreamResponse({
        stream: result.stream,
        consumeSseStream: consumeStream,
      });
    } catch (err) {
      console.error("[decopilot:stream] Error", err);

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
  // Resume Endpoint — resume an orphaned in-progress run
  // ============================================================================

  app.post("/:org/decopilot/resume/:threadId", async (c) => {
    try {
      const { threadId, thread, organization } =
        await validateThreadOwnership(c);
      const ctx = c.get("meshContext");
      const userId = ctx.auth?.user?.id;
      if (!userId)
        throw new HTTPException(401, { message: "User ID is required" });

      // Precondition checks
      if (thread.status !== "in_progress")
        throw new HTTPException(409, {
          message: "Thread is not available for resume",
        });
      if (runRegistry.isRunning(threadId))
        throw new HTTPException(409, {
          message: "Thread is not available for resume",
        });
      if (!thread.run_config)
        throw new HTTPException(409, {
          message: "Thread is not available for resume",
        });

      // Validate stored config (schema drift protection)
      const parsed = PersistedRunConfigSchema.safeParse(thread.run_config);
      if (!parsed.success) {
        await threadStorage.forceFailIfInProgress(threadId, organization.id);
        throw new HTTPException(409, {
          message: "Thread is not available for resume",
        });
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

      // Atomic CAS claim
      const claimed = await threadStorage.claimOrphanedRun(
        threadId,
        organization.id,
        POD_ID,
      );
      if (!claimed)
        throw new HTTPException(409, {
          message: "Thread is not available for resume",
        });

      // Resume — identity from auth context, NOT stored config
      const result = await streamCore(
        {
          messages: [],
          models: toModelsConfig(config.models),
          agent: config.agent,
          temperature: config.temperature,
          toolApprovalLevel: config.toolApprovalLevel,
          organizationId: organization.id,
          userId,
          threadId,
          windowSize: config.windowSize,
          isResume: true,
        },
        ctx,
        { runRegistry, streamBuffer, cancelBroadcast },
      );

      return createUIMessageStreamResponse({
        stream: result.stream,
        consumeSseStream: consumeStream,
      });
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      if (err instanceof Error && err.name === "AbortError")
        return c.body(null, 204);
      console.error("[decopilot:resume] Unexpected error:", err);
      throw new HTTPException(500, { message: "Internal server error" });
    }
  });

  // ============================================================================
  // Cancel Endpoint — cancel ongoing run (local or via NATS to owning pod)
  // ============================================================================

  app.post("/:org/decopilot/cancel/:threadId", async (c) => {
    const { threadId, thread, organization } = await validateThreadOwnership(c);

    // Try to cancel locally first
    const cancelTransitions = await runRegistry.execute({
      type: "CANCEL",
      threadId,
    });
    if (cancelTransitions.some((t) => t.event.type === "RUN_FAILED")) {
      return c.json({ cancelled: true });
    }

    // Not on this pod — broadcast to all pods
    cancelBroadcast.broadcast(threadId);

    // Ghost run: server restarted while a run was in progress. No pod has this
    // run in memory, so the broadcast will never resolve. Force-fail the thread
    // in the DB so the user can send new messages.
    if (thread.status === "in_progress") {
      console.warn("[decopilot:cancel] Ghost run detected, force-failing", {
        threadId,
      });
      runRegistry
        .execute({
          type: "FORCE_FAIL",
          threadId,
          reason: "ghost",
          orgId: organization.id,
        })
        .catch((err) => {
          console.error(
            "[decopilot:cancel] Failed to force-fail ghost thread",
            {
              threadId,
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
      const { threadId } = await validateThreadAccess(c);

      if (!runRegistry.isRunning(threadId)) {
        return c.body(null, 204);
      }

      const replayChunkStream = await streamBuffer.createReplayStream(threadId);
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

      return createUIMessageStreamResponse({
        stream: replayStream,
        consumeSseStream: consumeStream,
      });
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:attach] Error", err);
      return c.body(null, 500);
    }
  });

  return app;
}
