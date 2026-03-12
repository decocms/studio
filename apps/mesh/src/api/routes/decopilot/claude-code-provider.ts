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

export function isClaudeCodeAvailable(): boolean {
  return !!Bun.which("claude");
}

/**
 * Convert chat messages to a prompt string for the Claude Agent SDK.
 */
function messagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    for (const part of msg.parts ?? []) {
      if ("text" in part && typeof part.text === "string") {
        parts.push(part.text);
      }
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
export const CLAUDE_CODE_MODELS = [
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

  // Start a step + text part (AI SDK expects step markers for status tracking)
  writer.write({ type: "start-step" });
  writer.write({ type: "text-start", id: textPartId });

  let totalCostUsd = 0;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    for await (const message of conversation) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        case "stream_event": {
          // Only handle main thread events (no subagent)
          if (message.parent_tool_use_id) break;

          const event = message.event;

          if (
            event.type === "content_block_delta" &&
            "delta" in event &&
            event.delta
          ) {
            const delta = event.delta as { type: string; text?: string };
            if (delta.type === "text_delta" && delta.text) {
              writer.write({
                type: "text-delta",
                delta: delta.text,
                id: textPartId,
              });
            }
          }
          break;
        }

        case "result": {
          if (message.subtype === "success") {
            totalCostUsd = message.total_cost_usd ?? 0;
            const u = message.usage;
            if (u) {
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              };
            }
          } else {
            // Error result
            const errors = (message as { errors?: string[] }).errors ?? [];
            if (errors.length > 0) {
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
          if (message.parent_tool_use_id) break;

          // Handle errors
          if (message.error) {
            const errorMessages: Record<string, string> = {
              authentication_failed:
                "Claude Code is not authenticated. Run `claude login` in your terminal.",
              billing_error:
                "Claude Code billing error. Check your subscription.",
              rate_limit: "Claude Code rate limited. Please try again shortly.",
            };
            writer.write({
              type: "error",
              errorText:
                errorMessages[message.error] ??
                `Claude Code error: ${message.error}`,
            });
            break;
          }

          // Extract text content from the full assistant message
          const content = (
            message.message as { content?: { type: string; text?: string }[] }
          )?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                writer.write({
                  type: "text-delta",
                  delta: block.text,
                  id: textPartId,
                });
              }
            }
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error("[claude-code] Stream error:", err);
    writer.write({
      type: "error",
      errorText:
        err instanceof Error ? err.message : "Claude Code stream failed",
    });
  }

  // End the text part + step
  writer.write({ type: "text-end", id: textPartId });
  writer.write({ type: "finish-step" });

  writer.write({
    type: "finish",
    finishReason: "stop",
    messageMetadata: {
      usage,
    },
  });

  return { costUsd: totalCostUsd, usage };
}
