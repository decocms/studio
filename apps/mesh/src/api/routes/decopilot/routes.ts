/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import { getUserId, type MeshContext } from "@/core/mesh-context";
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
  // Connect Studio — register/check/remove MCP servers in IDEs
  // ============================================================================

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

  function buildMcpOrigin(): string {
    const serverPort = process.env.PORT || "3000";
    return `http://localhost:${serverPort}`;
  }

  function buildClaudeCodeConfig(
    origin: string,
    apiKey: string,
    orgId: string,
  ) {
    return {
      type: "http",
      url: `${origin}/mcp/self`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-org-id": orgId,
        "x-mesh-client": "Claude Code",
      },
    };
  }

  function buildCursorConfig(origin: string, apiKey: string, orgId: string) {
    return {
      mcpServers: {
        "deco-studio": {
          url: `${origin}/mcp/self`,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "x-org-id": orgId,
          },
        },
      },
    };
  }

  function buildCodexConfig(origin: string, apiKey: string, orgId: string) {
    return [
      "[mcp_servers.deco-studio]",
      `url = "${origin}/mcp/self"`,
      `http_headers = { "Authorization" = "Bearer ${apiKey}", "x-org-id" = "${orgId}" }`,
    ].join("\n");
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

  async function getCursorStatus() {
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const configPath = `${homedir()}/.cursor/mcp.json`;
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      return { connected: !!config?.mcpServers?.["deco-studio"] };
    } catch {
      return { connected: false };
    }
  }

  async function getCodexStatus() {
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const configPath = `${homedir()}/.codex/config.toml`;
      const content = await readFile(configPath, "utf-8");
      return { connected: content.includes("[mcp_servers.deco-studio]") };
    } catch {
      return { connected: false };
    }
  }

  app.get("/:org/decopilot/connect-studio/status", async (c) => {
    const ctx = c.get("meshContext");
    if (!getUserId(ctx)) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const [claude, cursor, codex] = await Promise.all([
      getClaudeStatus(),
      getCursorStatus(),
      getCodexStatus(),
    ]);

    return c.json({ claude, cursor, codex });
  });

  app.post("/:org/decopilot/connect-studio", async (c) => {
    const ctx = c.get("meshContext");
    const organization = ensureOrganization(c);
    const userId = getUserId(ctx);
    if (!userId) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const body = await c.req.json().catch(() => ({}));
    const { target, tokenOnly } = body as {
      target?: string;
      tokenOnly?: boolean;
    };
    const origin = buildMcpOrigin();

    if (!target || !["claude-code", "cursor", "codex"].includes(target)) {
      throw new HTTPException(400, { message: `Unknown target: ${target}` });
    }

    // Create API key for this target
    const apiKey = await ctx.boundAuth.apiKey.create({
      name: `studio-connect-${target}-${userId}`,
      permissions: { "*": ["*"] },
      metadata: { internal: true, target, organization },
    });

    // Token-only mode: just return the key, let the frontend build the snippet
    if (tokenOnly) {
      return c.json({ success: true, token: apiKey.key });
    }

    // Auto-configure mode: write config to IDE
    if (target === "claude-code") {
      const config = buildClaudeCodeConfig(origin, apiKey.key, organization.id);
      const configJson = JSON.stringify(config);

      await runCli("claude", [
        "mcp",
        "remove",
        "deco-studio",
        "--scope",
        "user",
      ]);
      const result = await runCli(
        "claude",
        ["mcp", "add-json", "deco-studio", configJson, "--scope", "user"],
        10000,
      );

      if (!result.ok) {
        console.error("[connect-studio] claude mcp add-json failed", {
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return c.json({
          success: false,
          token: apiKey.key,
          configRaw: configJson,
        });
      }
      return c.json({
        success: true,
        token: apiKey.key,
        configRaw: configJson,
      });
    }

    if (target === "cursor") {
      const config = buildCursorConfig(origin, apiKey.key, organization.id);
      const configRaw = JSON.stringify(config, null, 2);

      try {
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const cursorDir = `${homedir()}/.cursor`;
        const configPath = `${cursorDir}/mcp.json`;

        await mkdir(cursorDir, { recursive: true });

        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(await readFile(configPath, "utf-8"));
        } catch {
          // File doesn't exist yet
        }

        const merged = {
          ...existing,
          mcpServers: {
            ...(existing.mcpServers as Record<string, unknown> | undefined),
            "deco-studio": config.mcpServers["deco-studio"],
          },
        };

        await writeFile(configPath, JSON.stringify(merged, null, 2));
        return c.json({ success: true, token: apiKey.key, configRaw });
      } catch (err) {
        console.error("[connect-studio] cursor config write failed", err);
        return c.json({ success: false, token: apiKey.key, configRaw });
      }
    }

    // codex
    const configRaw = buildCodexConfig(origin, apiKey.key, organization.id);

    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const codexDir = `${homedir()}/.codex`;
      const configPath = `${codexDir}/config.toml`;

      await mkdir(codexDir, { recursive: true });

      let existing = "";
      try {
        existing = await readFile(configPath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      const cleaned = existing.replace(
        /\[mcp_servers\.deco-studio\][^\[]*/s,
        "",
      );
      const updated = cleaned.trimEnd() + "\n\n" + configRaw + "\n";
      await writeFile(configPath, updated);
      return c.json({ success: true, token: apiKey.key, configRaw });
    } catch (err) {
      console.error("[connect-studio] codex config write failed", err);
      return c.json({ success: false, token: apiKey.key, configRaw });
    }
  });

  app.delete("/:org/decopilot/connect-studio", async (c) => {
    const ctx = c.get("meshContext");
    ensureOrganization(c);
    if (!getUserId(ctx)) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    const body = await c.req.json().catch(() => ({}));
    const target = (body as { target?: string }).target;

    if (target === "claude-code") {
      const result = await runCli("claude", [
        "mcp",
        "remove",
        "deco-studio",
        "--scope",
        "user",
      ]);
      if (!result.ok) {
        throw new HTTPException(500, {
          message: "Failed to remove deco-studio MCP from Claude Code",
        });
      }
      return c.json({ success: true });
    }

    if (target === "cursor") {
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const configPath = `${homedir()}/.cursor/mcp.json`;
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        if (config?.mcpServers?.["deco-studio"]) {
          delete config.mcpServers["deco-studio"];
          await writeFile(configPath, JSON.stringify(config, null, 2));
        }
        return c.json({ success: true });
      } catch {
        throw new HTTPException(500, {
          message: "Failed to remove deco-studio from Cursor config",
        });
      }
    }

    if (target === "codex") {
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const configPath = `${homedir()}/.codex/config.toml`;
        const content = await readFile(configPath, "utf-8");
        const updated = content.replace(
          /\[mcp_servers\.deco-studio\][^\[]*/s,
          "",
        );
        await writeFile(configPath, updated.trimEnd() + "\n");
        return c.json({ success: true });
      } catch {
        throw new HTTPException(500, {
          message: "Failed to remove deco-studio from Codex config",
        });
      }
    }

    throw new HTTPException(400, { message: `Unknown target: ${target}` });
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
