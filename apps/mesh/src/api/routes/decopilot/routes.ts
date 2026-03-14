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
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage } from "./types";
import { streamCore } from "./stream-core";

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

      const isClaudeCode = models.thinking.provider === "claude-code";

      // 2. Check model permissions (skip for Claude Code — uses local auth)
      if (!isClaudeCode) {
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
  // Connect Studio — check + register MCP servers in Claude Code
  // ============================================================================

  // Helper: run a CLI command and return { ok, stdout, stderr }
  async function runCli(
    cmd: string,
    args: string[],
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill();
        resolve({ ok: false, stdout, stderr: "timeout" });
      }, timeoutMs);
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message });
      });
    });
  }

  async function getClaudeStatus() {
    const { ok: connected } = await runCli("claude", [
      "mcp",
      "get",
      "deco-studio",
    ]);
    let auth: Record<string, string | undefined> | null = null;
    if (connected) {
      try {
        const { stdout } = await runCli("claude", ["auth", "status"]);
        const parsed = JSON.parse(stdout);
        if (parsed.loggedIn) {
          auth = {
            email: parsed.email,
            orgName: parsed.orgName,
            subscriptionType: parsed.subscriptionType,
          };
        }
      } catch {
        // Auth info not available
      }
    }
    return { connected, auth };
  }

  app.get("/:org/decopilot/connect-studio/status", async (c) => {
    const ctx = c.get("meshContext");
    if (!ctx.auth?.user?.id) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const claude = await getClaudeStatus();

    return c.json({ claude });
  });

  app.post("/:org/decopilot/connect-studio", async (c) => {
    const ctx = c.get("meshContext");
    const organization = ensureOrganization(c);
    const userId = ctx.auth?.user?.id;
    if (!userId) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const body = await c.req.json().catch(() => ({}));
    const target = (body as { target?: string }).target;

    if (target === "claude-code") {
      // Create API key for the MCP endpoint
      const apiKey = await ctx.boundAuth.apiKey.create({
        name: "studio-connect-claude-code",
        permissions: { "*": ["*"] },
        metadata: {
          internal: true,
          target: "claude-code",
          organization,
        },
      });

      const serverPort = process.env.PORT || "3000";
      const origin = `http://localhost:${serverPort}`;
      const mcpConfig = JSON.stringify({
        type: "http",
        url: `${origin}/mcp/self`,
        headers: {
          Authorization: `Bearer ${apiKey.key}`,
          "x-org-id": organization.id,
          "x-mesh-client": "Claude Code",
        },
      });

      const result = await runCli(
        "claude",
        ["mcp", "add-json", "deco-studio", mcpConfig, "--scope", "user"],
        10000,
      );
      if (!result.ok) {
        throw new HTTPException(500, {
          message: "Failed to register deco-studio MCP",
        });
      }
      return c.json({ success: true });
    }

    throw new HTTPException(400, { message: `Unknown target: ${target}` });
  });

  app.delete("/:org/decopilot/connect-studio", async (c) => {
    const ctx = c.get("meshContext");
    ensureOrganization(c);
    const userId = ctx.auth?.user?.id ?? ctx.auth?.apiKey?.userId;
    if (!userId) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const body = await c.req.json().catch(() => ({}));
    const target = (body as { target?: string }).target;

    let mcpName: string;
    if (target === "claude-code") {
      mcpName = "deco-studio";
    } else {
      throw new HTTPException(400, { message: `Unknown target: ${target}` });
    }

    const result = await runCli("claude", [
      "mcp",
      "remove",
      mcpName,
      "--scope",
      "user",
    ]);
    if (!result.ok) {
      throw new HTTPException(500, {
        message: `Failed to remove ${mcpName} MCP`,
      });
    }
    return c.json({ success: true });
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
