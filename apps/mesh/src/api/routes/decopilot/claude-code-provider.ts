/**
 * Claude Code Provider
 *
 * Adapter for the Claude Agent SDK that streams Claude Code responses
 * into AI SDK's UIMessageStreamWriter format.
 */

import type { UIMessageStreamWriter } from "ai";
import type { ChatMessage } from "./types";
import { generateMessageId } from "./constants";

// Lazily loaded SDK query function
let _query: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;

// Clear CLAUDECODE to prevent recursive invocation
delete process.env.CLAUDECODE;

async function getQuery() {
  if (!_query) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    _query = sdk.query;
  }
  return _query;
}

/**
 * Convert chat messages to a prompt string for the Claude Agent SDK.
 */
function messagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    const textParts: string[] = [];
    for (const part of msg.parts ?? []) {
      if ("text" in part && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) {
      const prefix = msg.role === "assistant" ? "Assistant" : "User";
      parts.push(`${prefix}: ${textParts.join("\n")}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Extract system prompt text from system messages.
 */
function extractSystemPrompt(messages: ChatMessage[]): string {
  const systemParts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "system") continue;
    for (const part of msg.parts ?? []) {
      if ("text" in part && typeof part.text === "string") {
        systemParts.push(part.text);
      }
    }
  }
  return systemParts.join("\n\n");
}

/** Claude Code model variants that can be selected in the UI */
const CLAUDE_CODE_MODELS = [
  {
    id: "claude-code:opus",
    sdkModel: "claude-opus-4-6",
    title: "Claude Code Opus",
    tier: "smarter" as const,
  },
  {
    id: "claude-code:sonnet",
    sdkModel: "claude-sonnet-4-6",
    title: "Claude Code Sonnet",
    tier: "faster" as const,
  },
  {
    id: "claude-code:haiku",
    sdkModel: "claude-haiku-4-5",
    title: "Claude Code Haiku",
    tier: "cheaper" as const,
  },
] as const;

export interface ClaudeCodeStreamOptions {
  messages: ChatMessage[];
  abortController?: AbortController;
  mcpEndpoint?: string;
  mcpHeaders?: Record<string, string>;
  agentId?: string;
  agentMode?: string;
  threadId: string;
  connectionId: string;
  /** SDK model identifier, e.g. "claude-sonnet-4-6" */
  model?: string;
}

/**
 * Stream Claude Code responses into a UIMessageStreamWriter.
 *
 * Uses the Claude Agent SDK's query() function to spawn a Claude Code
 * subprocess and converts the streaming SDKMessages into AI SDK format.
 */
export async function streamClaudeCode(
  writer: UIMessageStreamWriter,
  opts: ClaudeCodeStreamOptions,
): Promise<{
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  calledAuthTool: boolean;
  /** Accumulated text from the response, for persistence */
  responseText: string;
}> {
  const queryFn = await getQuery();

  const prompt = messagesToPrompt(opts.messages);
  const systemPrompt = extractSystemPrompt(opts.messages);

  const abortController = opts.abortController ?? new AbortController();

  // Resolve SDK model name from the model id (e.g. "claude-code:sonnet" → "claude-sonnet-4-6")
  const sdkModel = opts.model
    ? (CLAUDE_CODE_MODELS.find((m) => m.id === opts.model)?.sdkModel ??
      opts.model)
    : undefined;

  const queryOpts: Parameters<typeof queryFn>[0]["options"] = {
    maxTurns: 1,
    abortController,
    model: sdkModel,
    systemPrompt: systemPrompt || undefined,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    // Enable streaming events so we get thinking_delta + text_delta in real-time
    includePartialMessages: true,
    tools: [],
  };

  // If an MCP endpoint is provided, pass it so Claude Code can use mesh tools
  if (opts.mcpEndpoint) {
    queryOpts.mcpServers = {
      mesh: {
        type: "http" as const,
        url: opts.mcpEndpoint,
        headers: opts.mcpHeaders,
      },
    };
    // Allow more turns when tools are available
    queryOpts.maxTurns = 30;
    // Let Claude Code use its default tools + MCP tools
    queryOpts.tools = undefined;
  }

  let conversation: ReturnType<typeof queryFn>;
  try {
    conversation = queryFn({ prompt, options: queryOpts });
  } catch (err) {
    console.error("[claude-code] Failed to start query:", err);
    throw err;
  }

  // Emit a start message
  const messageId = generateMessageId();
  const textPartId = generateMessageId();
  writer.write({
    type: "start",
    messageId,
    messageMetadata: {
      agent: {
        id: opts.agentId ?? null,
        mode: opts.agentMode ?? "passthrough",
      },
      models: {
        connectionId: opts.connectionId,
        thinking: {
          id: opts.model ?? "claude-code",
          provider: "claude-code",
        },
      },
      created_at: new Date(),
      thread_id: opts.threadId,
    },
  });

  writer.write({ type: "start-step" });

  // Track content block types by index so we route deltas correctly
  const blockTypes = new Map<number, string>();
  let reasoningPartId: string | null = null;
  let textStarted = false;
  // Track which content we've already streamed via stream_event so we
  // don't duplicate it when the assistant message arrives.
  let streamedText = false;
  let streamedReasoning = false;

  let totalCostUsd = 0;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let responseText = "";
  // Track whether CONNECTION_AUTHENTICATE was called so the caller can emit auth cards
  let calledAuthTool = false;
  // Insert separator between text from different turns (after tool use)
  let needsTextSeparator = false;

  const ensureTextStarted = () => {
    if (!textStarted) {
      writer.write({ type: "text-start", id: textPartId });
      textStarted = true;
    }
  };

  try {
    for await (const message of conversation) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        case "stream_event": {
          // Only handle main thread events (no subagent)
          if (message.parent_tool_use_id) break;

          const event = message.event as {
            type: string;
            index?: number;
            content_block?: { type: string; name?: string; id?: string };
            delta?: {
              type: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            };
          };

          // Track block types so we know how to route deltas
          if (event.type === "content_block_start" && event.content_block) {
            const idx = event.index ?? 0;
            blockTypes.set(idx, event.content_block.type);

            if (event.content_block.type === "thinking") {
              reasoningPartId = generateMessageId();
              writer.write({
                type: "reasoning-start",
                id: reasoningPartId,
              });
            }

            // New text block after we already streamed text = new turn.
            // Insert a separator so text doesn't run together.
            if (event.content_block.type === "text" && streamedText) {
              needsTextSeparator = true;
            }
          }

          if (event.type === "content_block_delta" && event.delta) {
            const delta = event.delta;

            if (
              delta.type === "thinking_delta" &&
              delta.thinking &&
              reasoningPartId
            ) {
              streamedReasoning = true;
              writer.write({
                type: "reasoning-delta",
                delta: delta.thinking,
                id: reasoningPartId,
              });
            } else if (delta.type === "text_delta" && delta.text) {
              ensureTextStarted();
              if (needsTextSeparator) {
                writer.write({
                  type: "text-delta",
                  delta: "\n\n",
                  id: textPartId,
                });
                responseText += "\n\n";
                needsTextSeparator = false;
              }
              streamedText = true;
              responseText += delta.text;
              writer.write({
                type: "text-delta",
                delta: delta.text,
                id: textPartId,
              });
            }
          }

          if (event.type === "content_block_stop") {
            const idx = event.index ?? 0;
            if (blockTypes.get(idx) === "thinking" && reasoningPartId) {
              writer.write({ type: "reasoning-end", id: reasoningPartId });
              reasoningPartId = null;
            }
          }
          break;
        }

        // Tool progress — fires during tool execution with tool_name
        case "tool_progress": {
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }
          const progressToolName =
            (message as { tool_name?: string }).tool_name ?? "";

          // Track connection-related tool calls so caller can emit auth cards.
          // Claude Code prefixes MCP tools as mcp__<server>__<tool_name>.
          // Emit auth cards when a connection is created (needs auth) or
          // when the AI explicitly calls CONNECTION_AUTHENTICATE.
          if (
            progressToolName.includes("CONNECTION_AUTHENTICATE") ||
            progressToolName.includes("COLLECTION_CONNECTIONS_CREATE")
          ) {
            calledAuthTool = true;
          }
          break;
        }

        // Tool use summary — emit as reasoning so user sees tool activity
        case "tool_use_summary": {
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }
          const summaryText =
            (message as { summary?: string }).summary ?? "Using tool...";

          // Show tool activity as reasoning
          if (!reasoningPartId) {
            reasoningPartId = generateMessageId();
            writer.write({ type: "reasoning-start", id: reasoningPartId });
          }
          writer.write({
            type: "reasoning-delta",
            delta: `\n${summaryText}\n`,
            id: reasoningPartId,
          });
          // Next text output should start on a new line
          needsTextSeparator = true;
          break;
        }

        case "result": {
          if (message.subtype === "success") {
            totalCostUsd =
              (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
            const u = (
              message as {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              }
            ).usage;
            if (u) {
              const inputTokens = u.input_tokens ?? 0;
              const outputTokens = u.output_tokens ?? 0;
              usage = {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
              };
            }
          } else {
            const errors = (message as { errors?: string[] }).errors ?? [];
            if (errors.length > 0) {
              ensureTextStarted();
              writer.write({
                type: "error",
                errorText: errors.join("; "),
              });
            }
          }
          break;
        }

        case "assistant": {
          // Only handle main thread messages (no subagent)
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }

          // Handle errors
          if ((message as { error?: string }).error) {
            const errorCode = (message as { error: string }).error;
            const errorMessages: Record<string, string> = {
              authentication_failed:
                "Claude Code is not authenticated. Run `claude login` in your terminal.",
              billing_error:
                "Claude Code billing error. Check your subscription.",
              rate_limit: "Claude Code rate limited. Please try again shortly.",
            };
            ensureTextStarted();
            writer.write({
              type: "error",
              errorText:
                errorMessages[errorCode] ?? `Claude Code error: ${errorCode}`,
            });
            break;
          }

          // Extract content from the full assistant message
          const content = (
            message as {
              message?: {
                content?: {
                  type: string;
                  text?: string;
                  thinking?: string;
                }[];
              };
            }
          )?.message?.content;
          if (!Array.isArray(content)) break;

          for (const block of content) {
            // Stream thinking content as reasoning (skip if already streamed via stream_event)
            if (
              block.type === "thinking" &&
              block.thinking &&
              !streamedReasoning
            ) {
              if (!reasoningPartId) {
                reasoningPartId = generateMessageId();
                writer.write({ type: "reasoning-start", id: reasoningPartId });
              }
              writer.write({
                type: "reasoning-delta",
                delta: block.thinking,
                id: reasoningPartId,
              });
            }

            // Stream text content (skip if already streamed via stream_event)
            if (block.type === "text" && block.text && !streamedText) {
              ensureTextStarted();
              writer.write({
                type: "text-delta",
                delta: block.text,
                id: textPartId,
              });
            }
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error("[claude-code] Stream error:", err);
    ensureTextStarted();
    writer.write({
      type: "error",
      errorText:
        err instanceof Error ? err.message : "Claude Code stream failed",
    });
  }

  // Close any open reasoning block
  if (reasoningPartId) {
    writer.write({ type: "reasoning-end", id: reasoningPartId });
  }

  // Ensure text part is opened before closing it
  ensureTextStarted();
  writer.write({ type: "text-end", id: textPartId });
  writer.write({ type: "finish-step" });

  writer.write({
    type: "finish",
    finishReason: "stop",
    messageMetadata: {
      usage: {
        ...usage,
        providerMetadata: totalCostUsd
          ? {
              "claude-code": {
                usage: { cost: totalCostUsd },
              },
            }
          : undefined,
      },
    },
  });

  return { costUsd: totalCostUsd, usage, calledAuthTool, responseText };
}
