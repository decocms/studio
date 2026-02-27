/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import type { MeshContext } from "@/core/mesh-context";
import { clientFromConnection, withStreamingSupport } from "@/mcp-clients";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import {
  sanitizeProviderMetadata,
  createDecopilotStepEvent,
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
  type ThreadStatus,
} from "@decocms/mesh-sdk";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getBuiltInTools } from "./built-in-tools";
import {
  DECOPILOT_BASE_PROMPT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  generateMessageId,
  PARENT_STEP_LIMIT,
} from "./constants";
import {
  loadAndMergeMessages,
  processConversation,
  splitRequestMessages,
} from "./conversation";
import {
  ensureOrganization,
  toolsFromMCP,
  validateThreadOwnership,
} from "./helpers";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import { sseHub } from "@/event-bus";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { StreamBuffer } from "./stream-buffer";
import type { RunRegistry } from "./run-registry";
import {
  checkModelPermission,
  fetchModelPermissions,
  parseModelsToMap,
} from "./model-permissions";
import { createModelProviderFromClient } from "./model-provider";
import { StreamRequestSchema } from "./schemas";
import { resolveThreadStatus } from "./status";
import { genTitle } from "./title-generator";
import type { ChatMessage } from "./types";
import { ThreadMessage } from "@/storage/types";

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
    let failThread: (() => void) | undefined;
    let closeClients: (() => void) | undefined;
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
        !checkModelPermission(
          allowedModels,
          models.connectionId,
          models.thinking.id,
        )
      ) {
        throw new HTTPException(403, {
          message: "Model not allowed for your role",
        });
      }

      const windowSize = memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE;
      const resolvedThreadId = thread_id ?? memoryConfig?.thread_id;

      // Get connection entities and create/load memory in parallel
      const [virtualMcp, modelConnection, mem] = await Promise.all([
        ctx.storage.virtualMcps.findById(agent.id, organization.id),
        ctx.storage.connections.findById(models.connectionId, organization.id),
        createMemory(ctx.storage.threads, {
          organization_id: organization.id,
          thread_id: resolvedThreadId,
          userId,
          defaultWindowSize: windowSize,
        }),
      ]);
      const saveMessagesToThread = async (
        ...messages: (typeof requestMessage | undefined)[]
      ) => {
        const now = Date.now();
        const messagesToSave = [
          ...new Map(messages.filter(Boolean).map((m) => [m!.id, m!])).values(),
        ].map((message, i) => ({
          ...message,
          thread_id: mem.thread.id,
          created_at: new Date(now + i).toISOString(),
          updated_at: new Date(now + i).toISOString(),
        }));
        if (messagesToSave.length === 0) return;
        await mem.save(messagesToSave as ThreadMessage[]).catch((error) => {
          console.error("[decopilot:stream] Error saving messages", error);
        });
      };

      const completeThread = (status: ThreadStatus) => {
        ctx.storage.threads.update(mem.thread.id, { status }).catch((error) => {
          console.error(
            "[decopilot:stream] Error updating thread status",
            error,
          );
        });
        const runStatus = status === "completed" ? "completed" : "failed";
        runRegistry.finishRun(mem.thread.id, runStatus, (id) =>
          streamBuffer.purge(id),
        );
        sseHub.emit(
          organization.id,
          createDecopilotThreadStatusEvent(mem.thread.id, status),
        );
        sseHub.emit(
          organization.id,
          createDecopilotFinishEvent(mem.thread.id, status),
        );
      };

      failThread = () => completeThread("failed");

      if (!modelConnection) {
        throw new Error("Model connection not found");
      }

      if (!virtualMcp) {
        throw new Error("Agent not found");
      }

      // Mark thread as in_progress at the start of streaming
      await ctx.storage.threads.update(mem.thread.id, {
        status: "in_progress",
      });
      sseHub.emit(
        organization.id,
        createDecopilotThreadStatusEvent(mem.thread.id, "in_progress"),
      );

      // Register run so it survives client disconnect; cancel uses run's AbortController
      const run = runRegistry.startRun(mem.thread.id, organization.id, userId);
      const abortSignal = run.abortController.signal;

      // Purge stale buffered chunks from any previous run on this thread
      streamBuffer.purge(mem.thread.id);

      await saveMessagesToThread(requestMessage);

      // Always create a passthrough client (all real tools) + model client.
      // If mode is smart_tool_selection or code_execution, also create the strategy
      // client so we get the gateway meta-tools (SEARCH/DESCRIBE/CALL_TOOL/RUN_CODE).
      const isGatewayMode = agent.mode !== "passthrough";
      const [modelClient, passthroughClient, strategyClient] =
        await Promise.all([
          clientFromConnection(modelConnection, ctx, false),
          createVirtualClientFrom(virtualMcp, ctx, "passthrough"),
          isGatewayMode
            ? createVirtualClientFrom(virtualMcp, ctx, agent.mode)
            : Promise.resolve(null),
        ]);

      closeClients = () => {
        modelClient.close().catch(() => {});
        passthroughClient.close().catch(() => {});
        strategyClient?.close().catch(() => {});
      };

      // Add streaming support since agents may use streaming models
      const streamableModelClient = withStreamingSupport(
        modelClient,
        models.connectionId,
        modelConnection,
        ctx,
        { superUser: false },
      );

      // Extract model provider (can stay outside execute)
      const modelProvider = await createModelProviderFromClient(
        streamableModelClient,
        models,
      );

      // MCP client cleanup on run abort (cancel from any pod), not request abort
      abortSignal.addEventListener("abort", () => {
        closeClients?.();
        failThread!();
      });

      // Get server instructions if available (for virtual MCP agents)
      const serverInstructions = passthroughClient.getInstructions();

      // Merge platform instructions with request system messages
      const systemPrompt = DECOPILOT_BASE_PROMPT(serverInstructions);
      const allSystemMessages: ChatMessage[] = [
        systemPrompt,
        ...systemMessages,
      ];

      const maxOutputTokens =
        models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

      let streamFinished = false;
      let stepCount = 0;
      let pendingSave: Promise<void> | null = null;

      const allMessages = await loadAndMergeMessages(
        mem,
        requestMessage,
        allSystemMessages,
        windowSize,
      );

      const toolOutputMap = new Map<string, string>();
      // 4. Create stream with writer access for data parts
      // Pass originalMessages so handleUIMessageStreamFinish (used by onFinish)
      // can locate tool invocations from previous assistant messages during
      // tool-approval continuation flows.
      const uiStream = createUIMessageStream({
        originalMessages: allMessages,
        execute: async ({ writer }) => {
          // Create tools inside execute so they have access to writer
          // Always get the full passthrough tools (all real tools from connections)
          const passthroughTools = await toolsFromMCP(
            passthroughClient,
            toolOutputMap,
            writer,
            toolApprovalLevel,
          );

          // If using a gateway mode, also get the strategy meta-tools
          // (GATEWAY_SEARCH_TOOLS, GATEWAY_DESCRIBE_TOOLS, GATEWAY_CALL_TOOL / GATEWAY_RUN_CODE)
          const strategyTools = strategyClient
            ? await toolsFromMCP(
                strategyClient,
                toolOutputMap,
                writer,
                toolApprovalLevel,
              )
            : {};

          const builtInTools = await getBuiltInTools(
            writer,
            {
              modelProvider,
              organization,
              models,
              toolApprovalLevel,
              toolOutputMap,
            },
            ctx,
          );

          // Merge all tools: strategy meta-tools override passthrough tools with the same name,
          // and built-in tools take final precedence.
          const tools = {
            ...passthroughTools,
            ...strategyTools,
            ...builtInTools,
          };

          // In gateway modes, only expose the strategy meta-tools + built-ins to the LLM.
          // The passthrough tools are still registered (so the AI SDK won't throw if the
          // model calls a discovered tool directly), but the LLM won't see their schemas.
          const activeToolNames = strategyClient
            ? ([
                ...Object.keys(strategyTools),
                ...Object.keys(builtInTools),
              ] as (keyof typeof tools)[])
            : undefined;

          // Process conversation with tools for validation
          const {
            systemMessages: processedSystemMessages,
            messages: processedMessages,
            originalMessages,
          } = await processConversation(allMessages, {
            windowSize,
            models,
            tools,
          });

          ensureModelCompatibility(models, originalMessages);

          const shouldGenerateTitle = mem.thread.title === DEFAULT_THREAD_TITLE;
          if (shouldGenerateTitle) {
            genTitle({
              abortSignal,
              model: modelProvider.fastModel ?? modelProvider.thinkingModel,
              userMessage: JSON.stringify(processedMessages[0]?.content),
            }).then(async (title) => {
              if (!title) return;

              await ctx.storage.threads
                .update(mem.thread.id, { title })
                .catch((error) => {
                  console.error(
                    "[decopilot:stream] Error updating thread title",
                    error,
                  );
                });

              if (!streamFinished) {
                writer.write({
                  type: "data-thread-title",
                  data: { title },
                  transient: true,
                });
              }
            });
          }

          let reasoningStartAt: Date | null = null;
          let lastProviderMetadata: Record<string, unknown> | undefined;

          const result = streamText({
            model: modelProvider.thinkingModel,
            system: processedSystemMessages,
            messages: processedMessages,
            tools,
            activeTools: activeToolNames,
            temperature,
            maxOutputTokens,
            abortSignal,
            stopWhen: stepCountIs(PARENT_STEP_LIMIT),
            onError: async (error) => {
              console.error("[decopilot:stream] Error", error);
              throw error;
            },
          });

          const uiMessageStream = result.toUIMessageStream({
            originalMessages,
            generateMessageId,
            messageMetadata: ({ part }) => {
              if (part.type === "start") {
                return {
                  agent: { id: agent.id ?? null, mode: agent.mode },
                  models: {
                    connectionId: models.connectionId,
                    thinking: models.thinking,
                  },
                  created_at: new Date(),
                  thread_id: mem.thread.id,
                };
              }
              if (part.type === "reasoning-start") {
                if (reasoningStartAt === null) {
                  reasoningStartAt = new Date();
                }
                return { reasoning_start_at: reasoningStartAt };
              }
              if (part.type === "reasoning-end") {
                return { reasoning_end_at: new Date() };
              }

              if (part.type === "finish-step") {
                lastProviderMetadata = part.providerMetadata;
                return;
              }

              if (part.type === "finish") {
                const provider = models.thinking.provider;
                const totalUsage = part.totalUsage;
                const providerMeta =
                  lastProviderMetadata ??
                  (part as { providerMetadata?: Record<string, unknown> })
                    .providerMetadata;
                const usage = totalUsage
                  ? {
                      inputTokens: totalUsage.inputTokens ?? 0,
                      outputTokens: totalUsage.outputTokens ?? 0,
                      reasoningTokens: totalUsage.reasoningTokens ?? undefined,
                      totalTokens: totalUsage.totalTokens ?? 0,
                      providerMetadata: sanitizeProviderMetadata(
                        provider && providerMeta
                          ? {
                              ...providerMeta,
                              [provider]: {
                                ...((providerMeta[provider] as object) ?? {}),
                                reasoning_details: undefined,
                              },
                            }
                          : providerMeta,
                      ),
                    }
                  : undefined;

                return {
                  ...(usage && { usage }),
                };
              }

              return;
            },
          });

          writer.merge(
            streamBuffer.relay(uiMessageStream, mem.thread.id, abortSignal),
          );
        },
        onFinish: async ({ responseMessage, finishReason }) => {
          streamFinished = true;
          closeClients?.();

          if (pendingSave) await pendingSave;
          await saveMessagesToThread(responseMessage);

          // Abort listener already called failThread(); skip status update
          if (abortSignal.aborted) return;

          const threadStatus = resolveThreadStatus(
            finishReason,
            responseMessage?.parts as {
              type: string;
              state?: string;
              text?: string;
            }[],
          );

          completeThread(threadStatus);
        },
        onStepFinish: ({ responseMessage }) => {
          stepCount++;
          sseHub.emit(
            organization.id,
            createDecopilotStepEvent(mem.thread.id, stepCount),
          );
          if (stepCount % 5 === 0) {
            pendingSave = saveMessagesToThread(responseMessage).finally(() => {
              pendingSave = null;
            });
          }
        },
        onError: (error) => {
          streamFinished = true;
          closeClients?.();
          if (abortSignal.aborted)
            return error instanceof Error ? error.message : String(error);
          console.error("[decopilot] stream error:", error);

          if (mem.thread.id) {
            failThread!();
          }

          return error instanceof Error ? error.message : String(error);
        },
      });

      return createUIMessageStreamResponse({
        stream: uiStream,
        consumeSseStream: consumeStream,
      });
    } catch (err) {
      closeClients?.();
      if (failThread) {
        failThread();
      }

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
  // Cancel Endpoint — cancel ongoing run (local or via NATS to owning pod)
  // ============================================================================

  app.post("/:org/decopilot/cancel/:threadId", async (c) => {
    const { threadId } = await validateThreadOwnership(c);

    if (runRegistry.cancelLocal(threadId)) {
      return c.json({ cancelled: true });
    }

    // Not on this pod — broadcast to all pods
    cancelBroadcast.broadcast(threadId);
    return c.json({ cancelled: true, async: true }, 202);
  });

  // ============================================================================
  // Attach Endpoint — replay JetStream-buffered stream for late-joining clients
  // ============================================================================

  app.get("/:org/decopilot/attach/:threadId", async (c) => {
    try {
      const { threadId } = await validateThreadOwnership(c);

      const run = runRegistry.getRun(threadId);
      if (!run || run.status !== "running") {
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
