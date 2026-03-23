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
import { isDecopilot, sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import { createUIMessageStream, stepCountIs, streamText } from "ai";
import { getBuiltInTools } from "./built-in-tools";
import { createEnableToolsTool } from "./built-in-tools/enable-tools";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  DEFAULT_MAX_TOKENS,
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  generateMessageId,
  PARENT_STEP_LIMIT,
} from "./constants";
import { loadAndMergeMessages, processConversation } from "./conversation";
import { isToolVisibleToModel, toolsFromMCP } from "./helpers";
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
import type { ChatMessage, ModelInfo, ModelsConfig } from "./types";
import type { CancelBroadcast } from "./cancel-broadcast";
import { ThreadMessage } from "@/storage/types";
import type { MeshProvider } from "@/ai-providers/types";
import {
  createClaudeCodeModel,
  resolveClaudeCodeModelId,
} from "@/ai-providers/adapters/claude-code";
import { getInternalUrl } from "@/core/server-constants";

/**
 * Creates a language model from the provider, enabling reasoning when the
 * model advertises the "reasoning" capability (e.g. OpenRouter thinking models).
 */
export function createLanguageModel(provider: MeshProvider, model: ModelInfo) {
  if (model.capabilities?.reasoning !== false) {
    // Provider-specific settings (e.g. OpenRouter reasoning) are not part of
    // the generic ProviderV3 interface, so we cast to pass them through.
    const lm = (provider.aiSdk.languageModel as Function)(model.id, {
      reasoning: { enabled: true, effort: "medium" },
    });
    return lm as ReturnType<typeof provider.aiSdk.languageModel>;
  }
  return provider.aiSdk.languageModel(model.id);
}

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  id: string;
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
    const credentialKey = await ctx.storage.aiProviderKeys
      .findById(input.models.credentialId, input.organizationId)
      .catch(() => null);
    const isClaudeCode = credentialKey?.providerId === "claude-code";

    // 1. Check model permissions (skip for Claude Code in local mode)
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
      ]
        .filter((m) => m.parts && m.parts.length > 0)
        .map((message, i) => ({
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

    const maxOutputTokens =
      input.models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    let streamFinished = false;
    const pendingOps: Promise<void>[] = [];

    // Pre-load conversation (no system messages — those are built separately)
    const allMessages = await loadAndMergeMessages(
      mem,
      requestMessage,
      systemMessages,
      windowSize,
    );

    // Find the last Claude Code sessionId for session resume
    let resumeSessionId: string | undefined;
    if (isClaudeCode) {
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const msg = allMessages[i];
        if (
          msg?.role === "assistant" &&
          (msg.metadata as { claudeCodeSessionId?: string })
            ?.claudeCodeSessionId
        ) {
          resumeSessionId = (msg.metadata as { claudeCodeSessionId: string })
            .claudeCodeSessionId;
          break;
        }
      }
    }

    const toolOutputMap = new Map<string, string>();
    const organization = ctx.organization!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedWriter: { write: (part: any) => void } | null = null;

    const uiStream = createUIMessageStream({
      originalMessages: allMessages,
      execute: async ({ writer }) => {
        capturedWriter = writer;
        const passthroughClient = await createVirtualClientFrom(
          virtualMcp,
          ctx,
          "passthrough",
          false,
          { listTimeoutMs: 1_000 },
        );

        closeClients = () => {
          passthroughClient.close().catch(() => {});
        };

        const passthroughTools = isClaudeCode
          ? {}
          : await toolsFromMCP(
              passthroughClient,
              toolOutputMap,
              writer,
              input.toolApprovalLevel,
            );

        const builtInTools = isClaudeCode
          ? {}
          : await getBuiltInTools(
              writer,
              {
                provider: provider!,
                organization,
                models: input.models,
                toolApprovalLevel: input.toolApprovalLevel,
                toolOutputMap,
                passthroughClient,
              },
              ctx,
            );

        // Progressive tool disclosure: enable_tools + prepareStep
        const passthroughToolNames = new Set(Object.keys(passthroughTools));
        const builtInToolNames = Object.keys(builtInTools);
        const enabledTools = reconstructEnabledTools(
          allMessages,
          passthroughToolNames,
        );

        // Build tool annotations map for plan-mode gating in enable_tools
        const toolAnnotations = new Map<string, { readOnlyHint?: boolean }>();
        if (input.toolApprovalLevel === "plan" && !isClaudeCode) {
          const { tools: toolList } = await passthroughClient.listTools();
          for (const t of toolList) {
            toolAnnotations.set(t.name, {
              readOnlyHint: t.annotations?.readOnlyHint,
            });
          }
        }

        const tools = isClaudeCode
          ? {}
          : {
              ...passthroughTools,
              ...builtInTools,
              enable_tools: createEnableToolsTool(
                enabledTools,
                passthroughToolNames,
                {
                  toolApprovalLevel: input.toolApprovalLevel,
                  toolAnnotations,
                },
              ),
            };

        // Build composable system prompt array
        const basePrompt = buildBasePlatformPrompt();

        const [toolCatalog, promptCatalog] = await Promise.all([
          buildToolCatalog(passthroughClient, enabledTools),
          buildPromptCatalog(passthroughClient),
        ]);

        // Agent prompt: decopilot-specific or custom agent instructions
        const serverInstructions = passthroughClient.getInstructions();
        const agentPrompt = isDecopilot(input.agent.id)
          ? buildDecopilotAgentPrompt()
          : serverInstructions;

        // Plan mode system prompt injection
        const planModePrompt =
          input.toolApprovalLevel === "plan"
            ? "You are in plan mode. You can only read and explore — you cannot make changes. " +
              "When you have enough information, call `propose_plan` with a comprehensive markdown plan " +
              "that includes all discoveries, file locations, and implementation steps. " +
              "After approval, a new implementation thread will be created with this plan as the starting context. " +
              "Only read-only tools can be enabled via enable_tools."
            : null;

        const systemPrompts = [
          basePrompt,
          planModePrompt,
          toolCatalog,
          promptCatalog,
          agentPrompt,
        ].filter((s): s is string => Boolean(s?.trim()));

        const {
          systemMessages: processedSystemMessages,
          messages: processedMessages,
          originalMessages,
        } = await processConversation(allMessages, {
          windowSize,
          models: input.models,
          tools,
        });

        ensureModelCompatibility(input.models, originalMessages);

        const shouldGenerateTitle =
          mem.thread.title === DEFAULT_THREAD_TITLE && !isClaudeCode;
        if (shouldGenerateTitle) {
          genTitle({
            abortSignal: registrySignal,
            model: createLanguageModel(
              provider!,
              input.models.fast ?? input.models.thinking,
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
        let claudeCodeSessionId: string | undefined;
        llmCallStartTime = Date.now();

        // Build language model based on provider type
        let languageModel;

        if (isClaudeCode) {
          // Mint a short-lived API key for Claude Code to auth with the MCP endpoint
          const apiKey = await ctx.boundAuth.apiKey.create({
            name: "claude-code-session",
            expiresIn: 3600,
            metadata: {
              organization: {
                id: organization.id,
                slug: organization.slug,
                name: organization.name,
              },
            },
          });

          const mcpUrl = `${getInternalUrl()}/mcp/virtual-mcp/${input.agent.id}`;
          languageModel = createClaudeCodeModel(
            resolveClaudeCodeModelId(input.models.thinking.id),
            {
              mcpServers: {
                agent: {
                  type: "http",
                  url: mcpUrl,
                  headers: {
                    Authorization: `Bearer ${apiKey.key}`,
                    "x-org-id": input.organizationId,
                  },
                },
              },
              toolApprovalLevel: input.toolApprovalLevel,
              resume: resumeSessionId,
            },
          );
        } else {
          languageModel = createLanguageModel(provider!, input.models.thinking);
        }

        const result = streamText({
          model: languageModel,
          system: [
            ...systemPrompts.map((content) => ({
              role: "system" as const,
              content,
            })),
            ...processedSystemMessages,
          ],
          messages: processedMessages,
          tools,
          ...(isClaudeCode
            ? {}
            : {
                prepareStep: () => {
                  let activeToolNames = [
                    ...builtInToolNames,
                    "enable_tools",
                    ...enabledTools,
                  ];

                  // Layer 2: In plan mode, filter out any non-read-only tools that
                  // somehow got enabled (safety net for Layer 1 in enable_tools)
                  if (input.toolApprovalLevel === "plan") {
                    activeToolNames = activeToolNames.filter((name) => {
                      // Built-in tools and enable_tools are always allowed
                      if (
                        builtInToolNames.includes(name) ||
                        name === "enable_tools"
                      ) {
                        return true;
                      }
                      // Only allow passthrough tools with readOnlyHint
                      const annotations = toolAnnotations.get(name);
                      return annotations?.readOnlyHint === true;
                    });
                  }

                  return {
                    activeTools: activeToolNames as (keyof typeof tools)[],
                  };
                },
                temperature: input.temperature,
                maxOutputTokens,
                stopWhen: stepCountIs(PARENT_STEP_LIMIT),
              }),
          abortSignal: registrySignal,
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
          onError: (error) => sanitizeStreamError(error),
          messageMetadata: ({ part }) => {
            if (part.type === "start") {
              return {
                agent: {
                  id: input.agent.id ?? null,
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
              if (isClaudeCode && part.providerMetadata?.["claude-code"]) {
                claudeCodeSessionId = (
                  part.providerMetadata["claude-code"] as {
                    sessionId?: string;
                  }
                ).sessionId;
              }
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
                ...(claudeCodeSessionId && { claudeCodeSessionId }),
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
        // Emit data-connection-auth for newly created connections that need auth
        if (capturedWriter && responseMessage?.parts) {
          for (const part of responseMessage.parts) {
            if (
              "toolName" in part &&
              part.toolName === "CONNECTION_INSTALL" &&
              "result" in part &&
              part.result &&
              typeof part.result === "object"
            ) {
              const result = part.result as {
                needs_auth?: boolean;
                connection_id?: string;
                title?: string;
                icon?: string | null;
                connection_url?: string | null;
              };
              if (result.needs_auth && result.connection_id) {
                capturedWriter.write({
                  type: "data-connection-auth",
                  data: {
                    connectionId: result.connection_id,
                    title: result.title ?? "Connection",
                    icon: result.icon ?? null,
                    connectionUrl: result.connection_url ?? null,
                  },
                });
              }
            }
          }
        }

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
          return sanitizeStreamError(error);
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

        return sanitizeStreamError(error);
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

function stripProviderSpecificDetails(message: string): string {
  const sentences = message.split(/\.\s+/);
  const cleaned = sentences.filter(
    (s) => !/https?:\/\//i.test(s) && !/openrouter/i.test(s),
  );
  if (cleaned.length === 0) return message;
  const result = cleaned.join(". ").trim();
  return result.endsWith(".") ? result : `${result}.`;
}

/**
 * Returns a sanitized, user-facing error message.
 * Provider-specific URLs and branding are stripped so they are never
 * surfaced to the client.
 */
// TODO @pedrofrxncx: remove this code in favor of a better solution
function sanitizeStreamError(error: unknown): string {
  if (error instanceof Error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 402 || error.message.toLowerCase().includes("credit")) {
      return stripProviderSpecificDetails(error.message);
    }
    return error.message;
  }
  return String(error);
}

/**
 * Reconstruct the set of enabled tools from conversation history.
 * Scans for prior `enable_tools` calls and re-adds their tool names.
 */
function reconstructEnabledTools(
  messages: ChatMessage[],
  availableToolNames: Set<string>,
): Set<string> {
  const enabled = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (
        "toolName" in part &&
        part.toolName === "enable_tools" &&
        "result" in part &&
        part.result
      ) {
        const result = part.result as { enabled?: string[] };
        if (Array.isArray(result.enabled)) {
          for (const name of result.enabled) {
            if (availableToolNames.has(name)) {
              enabled.add(name);
            }
          }
        }
      }
    }
  }
  return enabled;
}

const REDUNDANT_PREFIXES =
  /^(this tool |use this to |allows you to |a tool that |a tool to |tool to |tool that )/i;

function trimToolDescription(desc: string, maxLen = 80): string {
  let trimmed = desc.replace(REDUNDANT_PREFIXES, "").trim();
  if (trimmed.length > 0) {
    trimmed = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  }
  if (trimmed.length > maxLen) {
    return trimmed.slice(0, maxLen - 1) + "…";
  }
  return trimmed;
}

/**
 * Build a compact tool catalog for the system prompt, grouped by connection.
 * Format: <available-connections><connection name="..." id="...">TOOL|desc</connection></available-connections>
 */
async function buildToolCatalog(
  client: {
    listTools(): Promise<{
      tools: Array<{
        name: string;
        description?: string;
        _meta?: Record<string, unknown>;
      }>;
    }>;
  },
  enabledTools: Set<string>,
): Promise<string | null> {
  const { tools } = await client.listTools();

  const connections = new Map<
    string,
    { name: string; id: string; lines: string[] }
  >();

  for (const t of tools) {
    if (enabledTools.has(t.name)) continue;
    if (!isToolVisibleToModel(t)) continue;

    const connId = (t._meta?.connectionId as string) ?? "unknown";
    const connName = (t._meta?.connectionTitle as string) || connId;
    const desc = trimToolDescription(t.description ?? "");

    let group = connections.get(connId);
    if (!group) {
      group = { name: connName, id: connId, lines: [] };
      connections.set(connId, group);
    }
    group.lines.push(`${t.name}|${desc}`);
  }

  if (connections.size === 0) return null;

  const sections: string[] = [];
  for (const { name, id, lines } of connections.values()) {
    sections.push(
      `<connection name="${escapeXmlAttr(name)}" id="${escapeXmlAttr(id)}">\n${lines.join("\n")}\n</connection>`,
    );
  }

  return `\n\n<available-connections>\n${sections.join("\n")}\n</available-connections>`;
}

function escapeXmlAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Build a compact prompt catalog for the system prompt.
 * Format: <available-prompts>name|description\n...</available-prompts>
 */
async function buildPromptCatalog(client: {
  listPrompts(): Promise<{
    prompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; required?: boolean }>;
    }>;
  }>;
}): Promise<string | null> {
  const { prompts } = await client.listPrompts();
  if (prompts.length === 0) return null;

  const lines = prompts.map((p) => {
    let line = `${p.name}|${p.description ?? ""}`;
    if (p.arguments && p.arguments.length > 0) {
      const args = p.arguments
        .map((a) => (a.required ? `${a.name} (required)` : a.name))
        .join(", ");
      line += `|args: ${args}`;
    }
    return line;
  });

  return `\n\n<available-prompts>\n${lines.join("\n")}\n</available-prompts>`;
}

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
