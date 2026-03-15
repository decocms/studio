/**
 * Stream Core
 *
 * Extracted core logic from the /stream route handler.
 * This module is HTTP-agnostic and can be invoked by both the
 * SSE endpoint and automation runners.
 */

import type { MeshContext } from "@/core/mesh-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import { createUIMessageStream, stepCountIs, streamText } from "ai";
import { getBuiltInTools } from "./built-in-tools";
import {
  DECOPILOT_BASE_PROMPT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  generateMessageId,
  PARENT_STEP_LIMIT,
} from "./constants";
import { loadAndMergeMessages, processConversation } from "./conversation";
import { toolsFromMCP } from "./helpers";
import type { ToolApprovalLevel } from "./helpers";
import { createMemory } from "./memory";
import { ensureModelCompatibility } from "./model-compat";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "./model-permissions";
import type { RunRegistry } from "./run-registry";
import { resolveThreadStatus } from "./status";
import type { StreamBuffer } from "./stream-buffer";
import { genTitle } from "./title-generator";
import type { ChatMessage, ModelsConfig } from "./types";
import type { CancelBroadcast } from "./cancel-broadcast";
import { streamClaudeCode } from "./claude-code-provider";
import { ThreadMessage } from "@/storage/types";

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  id: string;
  mode: "passthrough" | "smart_tool_selection" | "code_execution";
}

export interface StreamCoreInput {
  messages: ChatMessage[];
  models: ModelsConfig;
  agent: AgentConfig;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  organizationId: string;
  userId: string;
  threadId?: string;
  triggerId?: string;
  windowSize?: number;
  abortSignal?: AbortSignal;
  /** Claude Code plan mode — produces a plan without executing tools */
  planMode?: boolean;
}

export interface StreamCoreDeps {
  runRegistry: RunRegistry;
  streamBuffer?: StreamBuffer;
  cancelBroadcast: CancelBroadcast;
}

export interface StreamCoreResult {
  threadId: string;
  stream: ReadableStream;
}

// ============================================================================
// Core Logic
// ============================================================================

export async function streamCore(
  input: StreamCoreInput,
  ctx: MeshContext,
  deps: StreamCoreDeps,
): Promise<StreamCoreResult> {
  const { runRegistry, streamBuffer } = deps;

  let closeClients: (() => void) | undefined;
  let runStarted = false;
  let threadId: string | undefined;
  let llmCallStartTime: number | undefined;
  let llmCallLogged = false;

  try {
    const isClaudeCode = input.models.thinking.provider === "claude-code";

    // 1. Check model permissions (skip for Claude Code — uses local auth)
    if (!isClaudeCode) {
      const allowedModels = await fetchModelPermissions(
        ctx.db,
        input.organizationId,
        ctx.auth.user?.role,
      );

      if (
        !checkModelPermission(
          allowedModels,
          input.models.credentialId,
          input.models.thinking.id,
        )
      ) {
        throw new Error("Model not allowed for your role");
      }
    }

    const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;

    // 2. Load entities and create/load memory in parallel
    const [virtualMcp, provider, mem] = await Promise.all([
      ctx.storage.virtualMcps.findById(input.agent.id, input.organizationId),
      isClaudeCode
        ? Promise.resolve(null)
        : ctx.aiProviders.activate(
            input.models.credentialId,
            input.organizationId,
          ),
      createMemory(ctx.storage.threads, {
        organization_id: input.organizationId,
        thread_id: input.threadId,
        userId: input.userId,
        defaultWindowSize: windowSize,
        triggerId: input.triggerId,
      }),
    ]);

    threadId = mem.thread.id;

    if (mem.thread.created_by !== input.userId) {
      throw new Error(
        "You are not allowed to write to this thread because you are not the owner",
      );
    }

    const saveMessagesToThread = async (
      ...messages: (ChatMessage | undefined)[]
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

    // 3. Dispatch START
    await runRegistry.execute({
      type: "START",
      threadId: mem.thread.id,
      orgId: input.organizationId,
      userId: input.userId,
      abortController: new AbortController(),
    });
    runStarted = true;

    const registrySignal = runRegistry.getAbortSignal(mem.thread.id);
    if (!registrySignal) {
      await runRegistry.execute({
        type: "FINISH",
        threadId: mem.thread.id,
        threadStatus: "failed",
      });
      throw new Error("Run was cancelled immediately after starting");
    }

    // If an external abort signal is provided (e.g. from automation runner),
    // forward it to the registry's abort controller so the run is cancelled.
    if (input.abortSignal) {
      const externalSignal = input.abortSignal;
      if (externalSignal.aborted) {
        await runRegistry.execute({
          type: "CANCEL",
          threadId: mem.thread.id,
        });
      } else {
        externalSignal.addEventListener(
          "abort",
          () => {
            runRegistry
              .execute({ type: "CANCEL", threadId: mem.thread.id })
              .catch(() => {});
          },
          { once: true },
        );
      }
    }

    // Purge stale buffered chunks from any previous run on this thread
    streamBuffer?.purge(mem.thread.id);

    // Split system messages from user message
    const systemMessages = input.messages.filter((m) => m.role === "system");
    const requestMessage = input.messages.find((m) => m.role !== "system");

    if (!requestMessage) {
      throw new Error(
        "No user message found in input — expected at least one non-system message",
      );
    }

    await saveMessagesToThread(requestMessage);

    // Close MCP clients on abort
    registrySignal.addEventListener("abort", () => {
      closeClients?.();
    });

    const isGatewayMode = input.agent.mode !== "passthrough";
    const maxOutputTokens =
      input.models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    let streamFinished = false;
    const streamStartTime = Date.now();
    const pendingOps: Promise<void>[] = [];

    // Pre-load conversation
    const allMessages = await loadAndMergeMessages(
      mem,
      requestMessage,
      [DECOPILOT_BASE_PROMPT(), ...systemMessages],
      windowSize,
    );

    const toolOutputMap = new Map<string, string>();
    const organization = ctx.organization!;

    const uiStream = createUIMessageStream({
      originalMessages: allMessages,
      execute: async ({ writer }) => {
        // ── Claude Code path ──────────────────────────────────────────
        if (isClaudeCode) {
          const { getInternalUrl } = await import("@/core/server-constants");
          const internalUrl = getInternalUrl();

          // Build MCP endpoint so Claude Code can reach Mesh tools
          const mcpEndpoint = `${internalUrl}/mcp/self`;
          const apiKeyRecord = await ctx.boundAuth.apiKey.create({
            name: "claude-code-session",
            permissions: { "*": ["*"] },
            metadata: {
              internal: true,
              target: "claude-code",
              organization: ctx.organization,
            },
          });
          const mcpHeaders: Record<string, string> = {
            Authorization: `Bearer ${apiKeyRecord.key}`,
            "x-org-id": input.organizationId,
            "x-mesh-client": "Claude Code",
          };

          const abortController = new AbortController();
          registrySignal.addEventListener("abort", () => {
            abortController.abort();
          });

          llmCallStartTime = Date.now();
          let ccResult: Awaited<ReturnType<typeof streamClaudeCode>>;
          try {
            ccResult = await streamClaudeCode(writer, {
              messages: allMessages,
              abortController,
              mcpEndpoint,
              mcpHeaders,
              agentId: input.agent.id,
              agentMode: input.agent.mode,
              threadId: mem.thread.id,
              connectionId: input.models.credentialId,
              model: input.models.thinking.id,
              planMode: input.planMode,
            });
          } finally {
            // Revoke the ephemeral wildcard API key after the stream completes
            try {
              await ctx.boundAuth.apiKey.delete(apiKeyRecord.id);
            } catch (err) {
              console.error(
                "[decopilot:stream] Failed to revoke Claude Code session key",
                err,
              );
            }
          }

          // Record usage metrics
          if (ccResult.usage) {
            recordLlmCallMetrics({
              ctx,
              organizationId: input.organizationId,
              modelId: input.models.thinking.id,
              durationMs: Date.now() - (llmCallStartTime ?? Date.now()),
              isError: false,
              inputTokens: ccResult.usage.inputTokens,
              outputTokens: ccResult.usage.outputTokens,
            });
          }

          // Persist the assistant response so it survives page reload
          if (ccResult.responseText) {
            const responseMessage: ChatMessage = {
              id: generateMessageId(),
              role: "assistant",
              parts: [{ type: "text", text: ccResult.responseText }],
            };
            await saveMessagesToThread(responseMessage);
          }

          // Generate title for Claude Code threads (no AI SDK model available,
          // so extract from the first user message text).
          if (mem.thread.title === DEFAULT_THREAD_TITLE) {
            const userText =
              requestMessage?.parts
                ?.filter(
                  (p): p is { type: "text"; text: string } =>
                    "text" in p &&
                    typeof (p as { text?: unknown }).text === "string",
                )
                .map((p) => p.text)
                .join(" ")
                .trim() ?? "";
            if (userText) {
              const title = userText
                .replace(/\s+/g, " ")
                .slice(0, 60)
                .replace(/\s\S*$/, userText.length > 60 ? "…" : "");
              ctx.storage.threads
                .update(mem.thread.id, { title })
                .then(() => {
                  if (!streamFinished) {
                    writer.write({
                      type: "data-thread-title",
                      data: { title },
                      transient: true,
                    });
                  }
                })
                .catch(() => {});
            }
          }

          // Emit auth cards for connections created during this stream.
          // We compare created_at against the stream start time so we only
          // show cards for freshly installed connections, not pre-existing ones.
          try {
            const connections = await ctx.storage.connections.list(
              organization.id,
            );
            const { DownstreamTokenStorage } = await import(
              "@/storage/downstream-token"
            );
            const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
            for (const conn of connections) {
              // Skip the self connection (Mesh MCP)
              if (conn.id.endsWith("_self")) continue;

              // Only show auth cards for connections created during this
              // stream — not for pre-existing unauthenticated connections.
              const createdAt = new Date(conn.created_at).getTime();
              if (createdAt < streamStartTime) continue;

              // Skip connections that already have an OAuth token
              const existingToken = await tokenStorage
                .get(conn.id)
                .catch(() => null);
              if (existingToken?.accessToken) continue;
              // Skip connections with a stored connection_token
              if (conn.connection_token) continue;

              // Connection was just created with no auth — show auth card
              if (conn.connection_url) {
                writer.write({
                  type: "data-connection-auth",
                  data: {
                    connectionId: conn.id,
                    title: conn.title,
                    icon: conn.icon ?? null,
                    connectionUrl: conn.connection_url,
                    elicitationId: `auth-${conn.id}`,
                  },
                });
              }
            }
          } catch {
            // Best-effort
          }

          return;
        }

        // ── Standard AI provider path ─────────────────────────────────
        // provider is guaranteed non-null here (Claude Code returns early above)
        const activeProvider = provider!;

        const [passthroughClient, strategyClient] = await Promise.all([
          createVirtualClientFrom(virtualMcp, ctx, "passthrough"),
          isGatewayMode
            ? createVirtualClientFrom(virtualMcp, ctx, input.agent.mode)
            : Promise.resolve(null),
        ]);

        closeClients = () => {
          passthroughClient.close().catch(() => {});
          strategyClient?.close().catch(() => {});
        };

        // Enrich with agent-specific instructions
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
          input.toolApprovalLevel,
        );

        const strategyTools = strategyClient
          ? await toolsFromMCP(
              strategyClient,
              toolOutputMap,
              writer,
              input.toolApprovalLevel,
            )
          : {};

        const builtInTools = await getBuiltInTools(
          writer,
          {
            provider: activeProvider,
            organization,
            models: input.models,
            toolApprovalLevel: input.toolApprovalLevel,
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
          models: input.models,
          tools,
        });

        ensureModelCompatibility(input.models, originalMessages);

        const shouldGenerateTitle = mem.thread.title === DEFAULT_THREAD_TITLE;
        if (shouldGenerateTitle) {
          genTitle({
            abortSignal: registrySignal,
            model: activeProvider.aiSdk.languageModel(
              input.models.fast?.id ?? input.models.thinking.id,
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
          model: activeProvider.aiSdk.languageModel(input.models.thinking.id),
          system: processedSystemMessages,
          messages: processedMessages,
          tools,
          activeTools: activeToolNames,
          temperature: input.temperature,
          maxOutputTokens,
          abortSignal: registrySignal,
          stopWhen: stepCountIs(PARENT_STEP_LIMIT),
          onFinish: async ({
            usage,
            totalUsage,
            finishReason,
            request,
            response,
          }) => {
            if (registrySignal.aborted) return;
            const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
            llmCallLogged = true;
            recordLlmCallMetrics({
              ctx,
              organizationId: input.organizationId,
              modelId: input.models.thinking.id,
              durationMs,
              isError: false,
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
            });
            monitorLlmCall({
              ctx,
              organizationId: input.organizationId,
              agentId: input.agent.id,
              modelId: input.models.thinking.id,
              modelTitle:
                input.models.thinking.title ?? input.models.thinking.id,
              credentialId: input.models.credentialId,
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
              userId: input.userId,
              requestId: ctx.metadata.requestId,
              userAgent: ctx.metadata.userAgent ?? null,
            });
          },
          onError: async (error) => {
            console.error("[decopilot:stream] Error", error);
            if (registrySignal.aborted) {
              throw error;
            }
            if (!llmCallLogged) {
              const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
              llmCallLogged = true;
              recordLlmCallMetrics({
                ctx,
                organizationId: input.organizationId,
                modelId: input.models.thinking.id,
                durationMs,
                isError: true,
                errorType: error instanceof Error ? error.name : "Error",
              });
              monitorLlmCall({
                ctx,
                organizationId: input.organizationId,
                agentId: input.agent.id,
                modelId: input.models.thinking.id,
                modelTitle:
                  input.models.thinking.title ?? input.models.thinking.id,
                credentialId: input.models.credentialId,
                threadId: mem.thread.id,
                durationMs,
                isError: true,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
                userId: input.userId,
                requestId: ctx.metadata.requestId,
                userAgent: ctx.metadata.userAgent ?? null,
              });
            }
            throw error;
          },
        });

        const uiMessageStream = result.toUIMessageStream({
          originalMessages,
          generateMessageId,
          messageMetadata: ({ part }) => {
            if (part.type === "start") {
              return {
                agent: {
                  id: input.agent.id ?? null,
                  mode: input.agent.mode,
                },
                models: {
                  credentialId: input.models.credentialId,
                  thinking: {
                    ...input.models.thinking,
                    provider: input.models.thinking.provider ?? undefined,
                  },
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
              const provider = input.models.thinking.provider;
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

        if (streamBuffer) {
          writer.merge(
            streamBuffer.relay(uiMessageStream, mem.thread.id, registrySignal),
          );
        } else {
          writer.merge(uiMessageStream);
        }
      },
      onFinish: async ({ responseMessage, finishReason }) => {
        streamFinished = true;
        closeClients?.();

        await Promise.allSettled(pendingOps);
        await saveMessagesToThread(responseMessage);

        if (registrySignal.aborted) return;

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
        const transitions = runRegistry.dispatch({
          type: "STEP_DONE",
          threadId: mem.thread.id,
        });
        pendingOps.push(
          runRegistry.react(transitions).catch((e) => {
            console.error("[decopilot:stream] onStepFinish reactor failed", e);
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
        if (registrySignal.aborted) {
          return error instanceof Error ? error.message : String(error);
        }
        console.error("[decopilot] stream error:", error);

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

    return {
      threadId: mem.thread.id,
      stream: uiStream,
    };
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

    throw err;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Consume a StreamCoreResult by draining its ReadableStream.
 * Useful for automation runs where there is no SSE consumer.
 */
export async function consumeStreamCore(
  result: StreamCoreResult,
): Promise<void> {
  const reader = result.stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}
