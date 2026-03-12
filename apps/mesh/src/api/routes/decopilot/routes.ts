/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import type { MeshContext } from "@/core/mesh-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
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
  validateThreadAccess,
  validateThreadOwnership,
} from "./helpers";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { StreamBuffer } from "./stream-buffer";
import type { RunRegistry } from "./run-registry";
import {
  checkModelPermission,
  fetchModelPermissions,
  parseModelsToMap,
} from "./model-permissions";
import { StreamRequestSchema } from "./schemas";
import { resolveThreadStatus } from "./status";
import { genTitle } from "./title-generator";
import type { ChatMessage } from "./types";
import { ThreadMessage } from "@/storage/types";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";

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
    let runStarted = false;
    let closeClients: (() => void) | undefined;
    let threadId: string | undefined;
    let llmCallStartTime: number | undefined;
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

      // Get connection entities and create/load memory in parallel
      const [virtualMcp, mem] = await Promise.all([
        ctx.storage.virtualMcps.findById(agent.id, organization.id),
        createMemory(ctx.storage.threads, {
          organization_id: organization.id,
          thread_id: resolvedThreadId,
          userId,
          defaultWindowSize: windowSize,
        }),
      ]);

      threadId = mem.thread.id;

      if (mem.thread.created_by !== userId) {
        throw new HTTPException(403, {
          message:
            "You are not allowed to write to this thread because you are not the owner",
        });
      }

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

      if (!virtualMcp) {
        throw new Error("Agent not found");
      }

      // Dispatch START: marks thread in_progress in DB, emits SSE, registers run
      await runRegistry.execute({
        type: "START",
        threadId: mem.thread.id,
        orgId: organization.id,
        userId,
        abortController: new AbortController(),
      });
      runStarted = true;

      const abortSignal = runRegistry.getAbortSignal(mem.thread.id);
      if (!abortSignal) {
        // A CANCEL broadcast arrived between execute(START) and getAbortSignal.
        // The run was torn down before we could attach; treat as an error.
        await runRegistry.execute({
          type: "FINISH",
          threadId: mem.thread.id,
          threadStatus: "failed",
        });
        throw new HTTPException(409, {
          message: "Run was cancelled immediately after starting",
        });
      }

      // Purge stale buffered chunks from any previous run on this thread
      streamBuffer.purge(mem.thread.id);

      await saveMessagesToThread(requestMessage);

      // Close MCP clients on abort; run completion is handled by onFinish/onError
      abortSignal.addEventListener("abort", () => {
        closeClients?.();
      });

      const isGatewayMode = agent.mode !== "passthrough";
      const maxOutputTokens =
        models.thinking.limits?.maxOutputTokens || DEFAULT_MAX_TOKENS;

      let streamFinished = false;
      // Fire-and-forget promises from onStepFinish (reactor calls + periodic
      // saves). Accumulated here and flushed in onFinish before the final save
      // so message ordering is preserved.
      const pendingOps: Promise<void>[] = [];

      // Pre-load conversation with a basic system prompt (no agent-specific
      // instructions). Agent instructions come from the passthrough MCP
      // client which is created inside execute to avoid blocking the HTTP
      // response and triggering Cloudflare 524 timeouts.
      const allMessages = await loadAndMergeMessages(
        mem,
        requestMessage,
        [DECOPILOT_BASE_PROMPT(), ...systemMessages],
        windowSize,
      );

      const toolOutputMap = new Map<string, string>();
      const uiStream = createUIMessageStream({
        originalMessages: allMessages,
        execute: async ({ writer }) => {
          // Create MCP client connections inside execute so the SSE
          // response headers are flushed to the client before this
          // potentially slow I/O, preventing Cloudflare 524 timeouts.
          const [passthroughClient, strategyClient] = await Promise.all([
            createVirtualClientFrom(virtualMcp, ctx, "passthrough"),
            isGatewayMode
              ? createVirtualClientFrom(virtualMcp, ctx, agent.mode)
              : Promise.resolve(null),
          ]);

          closeClients = () => {
            passthroughClient.close().catch(() => {});
            strategyClient?.close().catch(() => {});
          };

          // Enrich the pre-loaded messages with agent-specific instructions
          // from the virtual MCP now that the client is available.
          const serverInstructions = passthroughClient.getInstructions();
          const enrichedMessages = serverInstructions?.trim()
            ? allMessages.map((msg) =>
                msg.id === "decopilot-system"
                  ? DECOPILOT_BASE_PROMPT(serverInstructions)
                  : msg,
              )
            : allMessages;

          const passthroughTools = await toolsFromMCP(
            passthroughClient,
            toolOutputMap,
            writer,
            toolApprovalLevel,
          );

          const strategyTools = strategyClient
            ? await toolsFromMCP(
                strategyClient,
                toolOutputMap,
                writer,
                toolApprovalLevel,
              )
            : {};

          const provider = await ctx.aiProviders.activate(
            models.credentialId,
            organization.id,
          );

          const builtInTools = await getBuiltInTools(
            writer,
            {
              provider,
              organization,
              models: {
                credentialId: models.credentialId,
                thinking: models.thinking,
              },
              toolApprovalLevel,
              toolOutputMap,
            },
            ctx,
          );

          const tools = {
            ...passthroughTools,
            ...strategyTools,
            ...builtInTools,
          };

          const activeToolNames = strategyClient
            ? ([
                ...Object.keys(strategyTools),
                ...Object.keys(builtInTools),
              ] as (keyof typeof tools)[])
            : undefined;

          const {
            systemMessages: processedSystemMessages,
            messages: processedMessages,
            originalMessages,
          } = await processConversation(enrichedMessages, {
            windowSize,
            models,
            tools,
          });

          ensureModelCompatibility(models, originalMessages);

          const shouldGenerateTitle = mem.thread.title === DEFAULT_THREAD_TITLE;
          if (shouldGenerateTitle) {
            genTitle({
              abortSignal,
              model: provider.aiSdk.languageModel(
                models.fast?.id ?? models.thinking.id,
              ),
              userMessage: JSON.stringify(processedMessages[0]?.content),
            })
              .then(async (title) => {
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
              })
              .catch((error) => {
                console.warn(
                  "[decopilot:stream] Title generation failed:",
                  error,
                );
              });
          }

          let reasoningStartAt: Date | null = null;
          let lastProviderMetadata: Record<string, unknown> | undefined;

          llmCallStartTime = Date.now();

          const result = streamText({
            model: provider.aiSdk.languageModel(models.thinking.id),
            system: processedSystemMessages,
            messages: processedMessages,
            tools,
            activeTools: activeToolNames,
            temperature,
            maxOutputTokens,
            abortSignal,
            stopWhen: stepCountIs(PARENT_STEP_LIMIT),
            onFinish: async ({
              usage,
              totalUsage,
              finishReason,
              request,
              response,
            }) => {
              if (abortSignal.aborted) return;
              const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
              monitorLlmCall({
                ctx,
                organizationId: organization.id,
                agentId: agent.id,
                modelId: models.thinking.id,
                modelTitle: models.thinking.title ?? models.thinking.id,
                credentialId: models.credentialId,
                threadId: mem.thread.id,
                durationMs,
                isError: false,
                finishReason,
                usage: {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  totalTokens: usage.totalTokens ?? 0,
                },
                totalUsage: {
                  inputTokens: totalUsage.inputTokens ?? 0,
                  outputTokens: totalUsage.outputTokens ?? 0,
                  totalTokens: totalUsage.totalTokens ?? 0,
                },
                request,
                response,
                userId: userId ?? null,
                requestId: ctx.metadata.requestId,
                userAgent: ctx.metadata.userAgent ?? null,
              });
            },
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
                // models cast: ChatModelsConfig still uses connectionId (PR5 will align)
                return {
                  agent: { id: agent.id ?? null, mode: agent.mode },
                  models: {
                    credentialId: models.credentialId,
                    thinking: {
                      id: models.thinking.id,
                      title: models.thinking.title,
                      provider: models.thinking.provider ?? undefined,
                      capabilities: models.thinking.capabilities,
                      limits: models.thinking.limits,
                    },
                  } as never,
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
                const thinkingProvider = models.thinking.provider;
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
                        thinkingProvider && providerMeta
                          ? {
                              ...providerMeta,
                              [thinkingProvider]: {
                                ...((providerMeta[
                                  thinkingProvider
                                ] as object) ?? {}),
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

          // Flush all fire-and-forget ops accumulated in onStepFinish before
          // the final save to preserve message ordering.
          await Promise.allSettled(pendingOps);
          await saveMessagesToThread(responseMessage);

          // CANCEL already dispatched FINISH via the abort path; skip
          if (abortSignal.aborted) return;

          const threadStatus = resolveThreadStatus(
            finishReason,
            responseMessage?.parts as {
              type: string;
              state?: string;
              text?: string;
            }[],
          );

          await runRegistry.execute({
            type: "FINISH",
            threadId: mem.thread.id,
            threadStatus,
          });
        },
        onStepFinish: ({ responseMessage }) => {
          // Sync callback — must not block the agent loop. Dispatch the command
          // synchronously (to inspect the resulting event), then fire the
          // reactor as a tracked promise to be flushed in onFinish.
          const transitions = runRegistry.dispatch({
            type: "STEP_DONE",
            threadId: mem.thread.id,
          });
          pendingOps.push(
            runRegistry.react(transitions).catch((e) => {
              console.error(
                "[decopilot:stream] onStepFinish reactor failed",
                e,
              );
            }),
          );
          const stepEvent = transitions[0]?.event;
          if (
            stepEvent?.type === "STEP_COMPLETED" &&
            stepEvent.stepCount % 5 === 0
          ) {
            pendingOps.push(
              saveMessagesToThread(responseMessage).catch((e) => {
                console.error("[decopilot:stream] onStepFinish save failed", e);
              }),
            );
          }
        },
        onError: (error) => {
          streamFinished = true;
          closeClients?.();
          if (abortSignal.aborted) {
            return error instanceof Error ? error.message : String(error);
          }
          console.error("[decopilot] stream error:", error);

          if (llmCallStartTime !== undefined) {
            const durationMs = Date.now() - llmCallStartTime;
            monitorLlmCall({
              ctx,
              organizationId: organization.id,
              agentId: agent.id,
              modelId: models.thinking.id,
              modelTitle: models.thinking.title ?? models.thinking.id,
              credentialId: models.credentialId,
              threadId: mem.thread.id,
              durationMs,
              isError: true,
              errorMessage:
                error instanceof Error ? error.message : String(error),
              userId: userId ?? null,
              requestId: ctx.metadata.requestId,
              userAgent: ctx.metadata.userAgent ?? null,
            });
          }

          runRegistry
            .execute({
              type: "FINISH",
              threadId: mem.thread.id,
              threadStatus: "failed",
            })
            .catch((e) => {
              console.error("[decopilot:stream] onError reactor failed", e);
            });

          return error instanceof Error ? error.message : String(error);
        },
      });

      return createUIMessageStreamResponse({
        stream: uiStream,
        consumeSseStream: consumeStream,
      });
    } catch (err) {
      closeClients?.();

      if (runStarted && threadId) {
        runRegistry
          .execute({
            type: "FINISH",
            threadId,
            threadStatus: "failed",
          })
          .catch((e) => {
            console.error("[decopilot:stream] catch-block reactor failed", e);
          });
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
