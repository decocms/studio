/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import type { MeshContext } from "@/core/mesh-context";
import { clientFromConnection, withStreamingSupport } from "@/mcp-clients";
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
import { ensureOrganization, toolsFromMCP } from "./helpers";
import { createMemory, Memory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
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
  let memory: Memory | undefined;
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
    memory = mem;

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

    // Create model client and virtual MCP client in parallel (they are independent)
    const [modelClient, mcpClient] = await Promise.all([
      clientFromConnection(modelConnection, ctx, false),
      createVirtualClientFrom(virtualMcp, ctx, agent.mode),
    ]);

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

    // CRITICAL: Register abort handler to ensure client cleanup on disconnect
    // Without this, when client disconnects mid-stream, onFinish/onError are NOT called
    // and the MCP client + transport streams leak (TextDecoderStream, 256KB buffers)
    const abortSignal = c.req.raw.signal;
    abortSignal.addEventListener("abort", () => {
      modelClient.close().catch(() => {});
      // Mark thread as failed on client disconnect
      if (mem.thread.id) {
        ctx.storage.threads
          .update(mem.thread.id, { status: "failed" })
          .catch(() => {});
      }
    });

    // Get server instructions if available (for virtual MCP agents)
    const serverInstructions = mcpClient.getInstructions();

    // Merge platform instructions with request system messages
    const systemPrompt = DECOPILOT_BASE_PROMPT(serverInstructions);
    const allSystemMessages: ChatMessage[] = [systemPrompt, ...systemMessages];

    const maxOutputTokens =
      models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    let streamFinished = false;

    const allMessages = await loadAndMergeMessages(
      mem,
      requestMessage,
      allSystemMessages,
      windowSize,
    );

    const toolOutputMap = new Map<string, string>();
    // 4. Create stream with writer access for data parts
    // IMPORTANT: Do NOT pass onFinish/onStepFinish to createUIMessageStream when
    // using writer.merge with toUIMessageStream that has originalMessages.
    // createUIMessageStream wraps its stream in handleUIMessageStreamFinish which
    // runs processUIMessageStream on every chunk. Without originalMessages, the outer
    // state starts with an empty assistant message, causing "No tool invocation found"
    // errors when tool-output-available chunks arrive (e.g. after tool approval flow).
    const uiStream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Create tools inside execute so they have access to writer
        const mcpTools = await toolsFromMCP(
          mcpClient,
          toolOutputMap,
          writer,
          toolApprovalLevel,
        );

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

        const tools = { ...mcpTools, ...builtInTools };

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
          temperature,
          maxOutputTokens,
          abortSignal,
          stopWhen: stepCountIs(PARENT_STEP_LIMIT),
          onError: async (error) => {
            console.error("[decopilot:stream] Error", error);
            throw error;
          },
        });

        writer.merge(
          result.toUIMessageStream({
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
            onFinish: async ({ responseMessage }) => {
              streamFinished = true;

              const now = Date.now();
              const messagesToSave = [
                ...new Map(
                  [requestMessage, responseMessage]
                    .filter(Boolean)
                    .map((m) => [m.id, m]),
                ).values(),
              ].map((message, i) => ({
                ...message,
                thread_id: mem.thread.id,
                created_at: new Date(now + i).toISOString(),
                updated_at: new Date(now + i).toISOString(),
              }));

              if (messagesToSave.length === 0) return;

              await mem.save(messagesToSave).catch((error) => {
                console.error(
                  "[decopilot:stream] Error saving messages",
                  error,
                );
              });

              // Determine and persist thread status
              const finishReason = await result.finishReason;
              const threadStatus = resolveThreadStatus(
                finishReason,
                responseMessage?.parts ?? [],
              );

              await ctx.storage.threads
                .update(mem.thread.id, { status: threadStatus })
                .catch((error) => {
                  console.error(
                    "[decopilot:stream] Error updating thread status",
                    error,
                  );
                });
            },
          }),
        );
      },
      onError: (error) => {
        streamFinished = true;
        console.error("[decopilot] stream error:", error);

        if (mem.thread.id) {
          ctx.storage.threads
            .update(mem.thread.id, { status: "failed" })
            .catch((statusErr) => {
              console.error(
                "[decopilot:stream] Error updating thread status on stream error",
                statusErr,
              );
            });
        }

        return error instanceof Error ? error.message : String(error);
      },
    });

    return createUIMessageStreamResponse({
      stream: uiStream,
      consumeSseStream: consumeStream,
    });
  } catch (err) {
    // If we have a thread, mark it as failed
    if (memory) {
      const ctx = c.get("meshContext");
      await ctx.storage.threads
        .update(memory.thread.id, { status: "failed" })
        .catch((statusErr: unknown) => {
          console.error(
            "[decopilot:stream] Failed to update thread status",
            statusErr,
          );
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

export default app;
