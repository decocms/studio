/**
 * Claude Code Provider
 *
 * Adapter for the Claude Agent SDK that streams Claude Code responses
 * into AI SDK's UIMessageStreamWriter format.
 *
 * Converts SDK messages into rich UI parts:
 * - stream_event → text, reasoning, tool-call-start/delta
 * - tool_progress → latency tracking per tool call
 * - tool_use_summary → tool-result fallback when user messages are not emitted
 * - user messages → tool-result with actual MCP tool outputs
 * - assistant messages → fallback for content not streamed in real-time
 * - task_started/task_progress/task_notification → subagent task cards
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
 * Check if the last user message contains image file parts.
 */
function hasImageParts(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    for (const part of msg.parts ?? []) {
      if (
        part.type === "file" &&
        "mediaType" in part &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/")
      ) {
        return true;
      }
    }
    break; // only check the last user message
  }
  return false;
}

/**
 * Build an Anthropic MessageParam content array from the last user message,
 * including both text and image blocks.
 */
function buildUserContent(messages: ChatMessage[]): Array<
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
> {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];

  // Add context from prior messages as text
  const priorParts: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (!msg || msg.role === "system") continue;
    const textParts: string[] = [];
    for (const part of msg.parts ?? []) {
      if ("text" in part && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) {
      const prefix = msg.role === "assistant" ? "Assistant" : "User";
      priorParts.push(`${prefix}: ${textParts.join("\n")}`);
    }
  }
  if (priorParts.length > 0) {
    content.push({
      type: "text",
      text: `Previous conversation:\n\n${priorParts.join("\n\n")}`,
    });
  }

  // Process the last user message with both text and images
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    for (const part of lastMsg.parts ?? []) {
      if ("text" in part && typeof part.text === "string" && part.text.trim()) {
        content.push({ type: "text", text: part.text });
      }
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string" &&
        "mediaType" in part &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/")
      ) {
        // Extract base64 data from data URL
        const dataUrl = part.url as string;
        const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (base64Match?.[1]) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType as string,
              data: base64Match[1],
            },
          });
        }
      }
    }
  }

  return content;
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
  /** When true, use plan mode — Claude Code produces a plan without executing tools */
  planMode?: boolean;
}

// ============================================================================
// Internal types for SDK message parsing
// ============================================================================

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    name?: string;
    id?: string;
    text?: string;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface ToolCallInfo {
  id: string;
  name: string;
  startTime: number;
  args: string;
}

/**
 * SDK internal control tools that should not be rendered as tool call cards.
 * These are handled internally by the Claude Agent SDK and their results
 * are not meaningful to show to the user.
 */
const SDK_CONTROL_TOOLS = new Set(["ExitPlanMode", "ExitPlanModeAndWritePlan"]);

// ============================================================================
// Stream state manager
// ============================================================================

/**
 * Manages the complex state machine for converting Claude Code SDK messages
 * into AI SDK UIMessageStream parts with proper step boundaries.
 */
class StreamState {
  private writer: UIMessageStreamWriter;

  // Part lifecycle
  textPartId: string;
  textStarted = false;
  reasoningPartId: string | null = null;

  // Deduplication: track what we streamed via stream_event
  streamedText = false;
  streamedReasoning = false;
  private streamedToolCalls = new Set<string>();

  // Tool call tracking
  private blockTypes = new Map<number, string>();
  private toolCallBlocks = new Map<number, ToolCallInfo>();
  private toolProgressTimes = new Map<string, number>();
  private pendingToolCalls = new Map<string, ToolCallInfo>();
  private resolvedToolCalls = new Set<string>();
  /** SDK control tool calls that are suppressed from the UI */
  private suppressedToolCalls = new Set<string>();
  hasActiveToolCalls = false;

  // Task/subagent tracking
  private activeTasks = new Map<
    string,
    { toolCallId: string; toolUseId?: string }
  >();

  // Text separators between turns
  needsTextSeparator = false;

  // Accumulated response text for persistence
  responseText = "";

  /**
   * Ordered list of completed parts for message persistence.
   * Text segments and tool calls are pushed as they finalize so the
   * persisted message faithfully reproduces what was streamed.
   */
  completedParts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
        type: "dynamic-tool";
        toolCallId: string;
        toolName: string;
        input: unknown;
        output: unknown;
        state: "output-available" | "output-error";
      }
  > = [];

  /** Tracks how much of responseText has been flushed into completedParts */
  private textFlushedLength = 0;

  /** Accumulated reasoning text for the current thinking block */
  private reasoningText = "";

  /** Total tool calls completed (for monitoring) */
  toolCallCount = 0;
  toolCallErrors = 0;

  constructor(writer: UIMessageStreamWriter) {
    this.writer = writer;
    this.textPartId = generateMessageId();
  }

  // ── Text part helpers ──────────────────────────────────────────────

  ensureTextStarted() {
    if (!this.textStarted) {
      this.writer.write({ type: "text-start", id: this.textPartId });
      this.textStarted = true;
    }
  }

  closeText() {
    if (this.textStarted) {
      this.writer.write({ type: "text-end", id: this.textPartId });
      this.textStarted = false;
    }
  }

  closeReasoning() {
    if (this.reasoningPartId) {
      this.writer.write({ type: "reasoning-end", id: this.reasoningPartId });
      this.reasoningPartId = null;
    }
  }

  /** Flush any new responseText since the last flush into completedParts */
  flushTextPart() {
    if (this.responseText.length > this.textFlushedLength) {
      const text = this.responseText.slice(this.textFlushedLength);
      this.completedParts.push({ type: "text", text });
      this.textFlushedLength = this.responseText.length;
    }
  }

  /** Close all open parts (text + reasoning) before tool calls or step end */
  closeOpenParts() {
    this.closeReasoning();
    this.closeText();
  }

  /** Reset text tracking for a new turn (after tool results) */
  resetForNewTurn() {
    this.textPartId = generateMessageId();
    this.textStarted = false;
    this.streamedText = false;
    this.streamedReasoning = false;
    this.needsTextSeparator = false;
    this.hasActiveToolCalls = false;
  }

  // ── Stream event handlers ──────────────────────────────────────────

  handleContentBlockStart(event: StreamEvent) {
    const block = event.content_block;
    if (!block) return;

    const idx = event.index ?? 0;
    this.blockTypes.set(idx, block.type);

    if (block.type === "thinking") {
      this.reasoningPartId = generateMessageId();
      this.writer.write({
        type: "reasoning-start",
        id: this.reasoningPartId,
      });
    }

    if (block.type === "tool_use") {
      const toolCallId = block.id ?? generateMessageId();
      const toolName = block.name ?? "unknown";

      // Track this tool call
      const info: ToolCallInfo = {
        id: toolCallId,
        name: toolName,
        startTime: performance.now(),
        args: "",
      };
      this.toolCallBlocks.set(idx, info);
      this.streamedToolCalls.add(toolCallId);

      // Suppress SDK control tools from the UI
      if (SDK_CONTROL_TOOLS.has(toolName)) {
        this.suppressedToolCalls.add(toolCallId);
        return;
      }

      // Close open text/reasoning before emitting tool calls
      this.closeOpenParts();

      this.pendingToolCalls.set(toolCallId, info);
      this.hasActiveToolCalls = true;

      // Emit tool input start (dynamic = true since these aren't registered tools)
      this.writer.write({
        type: "tool-input-start",
        toolCallId,
        toolName,
        dynamic: true,
      });
    }

    // New text block after we already streamed text = new turn.
    if (block.type === "text" && this.streamedText) {
      this.needsTextSeparator = true;
    }
  }

  handleContentBlockDelta(event: StreamEvent) {
    const delta = event.delta;
    if (!delta) return;

    const idx = event.index ?? 0;

    if (
      delta.type === "thinking_delta" &&
      delta.thinking &&
      this.reasoningPartId
    ) {
      this.streamedReasoning = true;
      this.reasoningText += delta.thinking;
      this.writer.write({
        type: "reasoning-delta",
        delta: delta.thinking,
        id: this.reasoningPartId,
      });
      return;
    }

    if (delta.type === "text_delta" && delta.text) {
      this.ensureTextStarted();
      if (this.needsTextSeparator) {
        this.writer.write({
          type: "text-delta",
          delta: "\n\n",
          id: this.textPartId,
        });
        this.responseText += "\n\n";
        this.needsTextSeparator = false;
      }
      this.streamedText = true;
      this.responseText += delta.text;
      this.writer.write({
        type: "text-delta",
        delta: delta.text,
        id: this.textPartId,
      });
      return;
    }

    // Tool use input JSON streaming
    if (delta.type === "input_json_delta" && delta.partial_json) {
      const toolBlock = this.toolCallBlocks.get(idx);
      if (toolBlock) {
        toolBlock.args += delta.partial_json;
        // Skip streaming input for suppressed SDK control tools
        if (!this.suppressedToolCalls.has(toolBlock.id)) {
          this.writer.write({
            type: "tool-input-delta",
            toolCallId: toolBlock.id,
            inputTextDelta: delta.partial_json,
          });
        }
      }
    }
  }

  handleContentBlockStop(event: StreamEvent) {
    const idx = event.index ?? 0;
    const blockType = this.blockTypes.get(idx);

    if (blockType === "thinking" && this.reasoningPartId) {
      this.writer.write({ type: "reasoning-end", id: this.reasoningPartId });
      // Persist reasoning text as a part so it survives page reload
      if (this.reasoningText) {
        this.flushTextPart();
        this.completedParts.push({
          type: "reasoning",
          text: this.reasoningText,
        });
        this.reasoningText = "";
      }
      this.reasoningPartId = null;
    }

    // Clean up tool call block tracking (tool call input complete)
    if (blockType === "tool_use") {
      this.toolCallBlocks.delete(idx);
    }
  }

  // ── Tool progress tracking ─────────────────────────────────────────

  handleToolProgress(message: {
    tool_use_id?: string;
    tool_name?: string;
    elapsed_time_seconds?: number;
  }) {
    if (message.tool_use_id && message.elapsed_time_seconds != null) {
      this.toolProgressTimes.set(
        message.tool_use_id,
        message.elapsed_time_seconds,
      );
    }
  }

  // ── Tool results ───────────────────────────────────────────────────

  /**
   * Emit tool-result for a specific tool call.
   * Also emits latency metadata if available from tool_progress.
   */
  emitToolResult(toolCallId: string, result: string, isError?: boolean) {
    if (this.resolvedToolCalls.has(toolCallId)) return;
    this.resolvedToolCalls.add(toolCallId);

    // Grab tool info before deleting from pending
    const toolBlock = this.pendingToolCalls.get(toolCallId);
    this.pendingToolCalls.delete(toolCallId);

    // Track tool call metrics (including suppressed ones for accurate counting)
    this.toolCallCount++;
    if (isError) this.toolCallErrors++;

    // Skip emitting results for suppressed SDK control tools
    if (this.suppressedToolCalls.has(toolCallId)) return;

    if (isError) {
      this.writer.write({
        type: "tool-output-error",
        toolCallId,
        errorText: result,
        dynamic: true,
      });
    } else {
      this.writer.write({
        type: "tool-output-available",
        toolCallId,
        output: result,
        dynamic: true,
      });
    }

    // Accumulate tool call part for persistence
    if (toolBlock) {
      // Flush any preceding text before the tool call
      this.flushTextPart();

      let parsedInput: unknown = toolBlock.args;
      try {
        parsedInput = JSON.parse(toolBlock.args);
      } catch {
        // keep as string
      }

      this.completedParts.push({
        type: "dynamic-tool",
        toolCallId,
        toolName: toolBlock.name,
        input: parsedInput,
        output: isError ? { error: result } : result,
        state: isError ? "output-error" : "output-available",
      });
    }

    // Emit latency metadata
    const elapsed = this.toolProgressTimes.get(toolCallId);
    const latencyMs = elapsed
      ? elapsed * 1000
      : toolBlock
        ? performance.now() - toolBlock.startTime
        : undefined;

    if (latencyMs != null) {
      this.writer.write({
        type: "data-tool-metadata",
        id: toolCallId,
        data: { latencyMs },
      });
    }
  }

  /**
   * Handle user messages which contain tool_result blocks.
   * These are synthesized by the SDK after MCP tool execution.
   */
  handleUserMessage(message: {
    message?: {
      content?: {
        type: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }[];
    };
  }) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const resultText = this.extractToolResultText(block.content);
        this.emitToolResult(
          block.tool_use_id,
          resultText,
          block.is_error === true,
        );
      }
    }

    this.finishToolCallStep();
  }

  /**
   * Handle tool_use_summary as a fallback for resolving pending tool calls.
   * If we haven't received explicit tool_result messages, the summary
   * provides at least a text description of what happened.
   */
  handleToolUseSummary(message: {
    summary?: string;
    preceding_tool_use_ids?: string[];
  }) {
    const summary = message.summary ?? "Tool completed";
    const precedingIds = message.preceding_tool_use_ids ?? [];

    // Resolve any pending tool calls that haven't received results yet
    for (const toolCallId of precedingIds) {
      if (!this.resolvedToolCalls.has(toolCallId)) {
        this.emitToolResult(
          toolCallId,
          JSON.stringify({
            content: [{ type: "text", text: summary }],
          }),
        );
      }
    }

    // If no preceding IDs, resolve ALL pending tool calls with the summary
    if (precedingIds.length === 0 && this.pendingToolCalls.size > 0) {
      for (const [toolCallId] of this.pendingToolCalls) {
        this.emitToolResult(
          toolCallId,
          JSON.stringify({
            content: [{ type: "text", text: summary }],
          }),
        );
      }
    }

    // If there were active tool calls, finish the step
    if (this.hasActiveToolCalls) {
      this.finishToolCallStep();
    }
  }

  /** Finish a tool call step and start a new step for the next turn */
  private finishToolCallStep() {
    if (!this.hasActiveToolCalls) return;

    this.writer.write({ type: "finish-step" });
    this.writer.write({ type: "start-step" });
    this.resetForNewTurn();
  }

  // ── Task/Subagent handling ─────────────────────────────────────────

  handleTaskStarted(message: {
    task_id?: string;
    tool_use_id?: string;
    description?: string;
    prompt?: string;
  }) {
    const taskId = message.task_id;
    if (!taskId) return;

    const toolCallId = generateMessageId();
    this.activeTasks.set(taskId, {
      toolCallId,
      toolUseId: message.tool_use_id,
    });

    // Close open parts
    this.closeOpenParts();

    // Emit as a tool input (will be rendered similar to subtask)
    this.writer.write({
      type: "tool-input-start",
      toolCallId,
      toolName: "subtask",
      dynamic: true,
    });
    this.hasActiveToolCalls = true;
  }

  handleTaskProgress(message: {
    task_id?: string;
    description?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    summary?: string;
  }) {
    const task = message.task_id
      ? this.activeTasks.get(message.task_id)
      : undefined;
    if (!task) return;

    // Emit subtask metadata with usage stats
    if (message.usage) {
      this.writer.write({
        type: "data-tool-subtask-metadata",
        id: task.toolCallId,
        data: {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: message.usage.total_tokens,
          },
        },
      });
    }
  }

  handleTaskNotification(message: {
    task_id?: string;
    status?: string;
    summary?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  }) {
    const task = message.task_id
      ? this.activeTasks.get(message.task_id)
      : undefined;
    if (!task) return;

    const summary = message.summary ?? "Task completed";
    const isError = message.status === "failed";

    this.emitToolResult(task.toolCallId, summary, isError);

    // Emit final usage metadata
    if (message.usage) {
      this.writer.write({
        type: "data-tool-subtask-metadata",
        id: task.toolCallId,
        data: {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: message.usage.total_tokens,
          },
        },
      });
    }

    this.activeTasks.delete(message.task_id!);

    // Finish step if no more active tasks/tools
    if (this.pendingToolCalls.size === 0 && this.activeTasks.size === 0) {
      this.finishToolCallStep();
    }
  }

  // ── Assistant message fallback ─────────────────────────────────────

  /**
   * Handle the full assistant message.
   * - Emits tool_use blocks not already streamed via stream_event
   * - Emits text/thinking not already streamed
   */
  handleAssistantMessage(
    content: {
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[],
  ) {
    for (const block of content) {
      // Thinking fallback
      if (
        block.type === "thinking" &&
        block.thinking &&
        !this.streamedReasoning
      ) {
        if (!this.reasoningPartId) {
          this.reasoningPartId = generateMessageId();
          this.writer.write({
            type: "reasoning-start",
            id: this.reasoningPartId,
          });
        }
        this.writer.write({
          type: "reasoning-delta",
          delta: block.thinking,
          id: this.reasoningPartId,
        });
      }

      // Text fallback
      if (block.type === "text" && block.text && !this.streamedText) {
        this.ensureTextStarted();
        this.responseText += block.text;
        this.writer.write({
          type: "text-delta",
          delta: block.text,
          id: this.textPartId,
        });
      }

      // Tool use fallback — emit tool calls not already streamed
      if (block.type === "tool_use" && block.id) {
        if (!this.streamedToolCalls.has(block.id)) {
          const toolCallId = block.id;
          const toolName = block.name ?? "unknown";
          const input = block.input ?? {};

          // Suppress SDK control tools
          if (SDK_CONTROL_TOOLS.has(toolName)) {
            this.streamedToolCalls.add(toolCallId);
            this.suppressedToolCalls.add(toolCallId);
          } else {
            this.closeOpenParts();
            this.streamedToolCalls.add(toolCallId);
            this.pendingToolCalls.set(toolCallId, {
              id: toolCallId,
              name: toolName,
              startTime: performance.now(),
              args: JSON.stringify(input),
            });
            this.hasActiveToolCalls = true;

            // Emit complete tool input (not streaming since we have it all)
            this.writer.write({
              type: "tool-input-available",
              toolCallId,
              toolName,
              input,
              dynamic: true,
            });
          }
        }
      }
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────

  private extractToolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (typeof c === "object" && c !== null) {
            if ("text" in c && typeof c.text === "string") return c.text;
            return JSON.stringify(c);
          }
          return String(c);
        })
        .join("\n");
    }
    if (content != null) return JSON.stringify(content);
    return "";
  }

  isToolCallStreamed(id: string): boolean {
    return this.streamedToolCalls.has(id);
  }
}

// ============================================================================
// Main export
// ============================================================================

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
  /** Accumulated text from the response, for persistence */
  responseText: string;
  /** Ordered parts (text + reasoning + tool calls) for faithful message persistence */
  parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
        type: "dynamic-tool";
        toolCallId: string;
        toolName: string;
        input: unknown;
        output: unknown;
        state: "output-available" | "output-error";
      }
  >;
  /** Tool call metrics for monitoring */
  toolCallCount: number;
  toolCallErrors: number;
}> {
  const queryFn = await getQuery();

  // When images are present, build an SDKUserMessage with content blocks.
  // Otherwise use plain text prompt.
  const containsImages = hasImageParts(opts.messages);
  const prompt = containsImages
    ? ((async function* () {
        yield {
          type: "user" as const,
          message: {
            role: "user" as const,
            content: buildUserContent(opts.messages),
          },
          parent_tool_use_id: null,
          session_id: "chat",
        };
      })() as AsyncIterable<
        import("@anthropic-ai/claude-agent-sdk").SDKUserMessage
      >)
    : messagesToPrompt(opts.messages);
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
    // Plan mode: Claude Code produces a plan without executing tools
    permissionMode: opts.planMode
      ? ("plan" as const)
      : ("bypassPermissions" as const),
    allowDangerouslySkipPermissions: !opts.planMode,
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

  const state = new StreamState(writer);

  let totalCostUsd = 0;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    for await (const message of conversation) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        case "stream_event": {
          // Only handle main thread events (no subagent)
          if (message.parent_tool_use_id) break;

          const event = message.event as StreamEvent;

          if (event.type === "content_block_start") {
            state.handleContentBlockStart(event);
          } else if (event.type === "content_block_delta") {
            state.handleContentBlockDelta(event);
          } else if (event.type === "content_block_stop") {
            state.handleContentBlockStop(event);
          }
          break;
        }

        case "tool_progress": {
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }
          state.handleToolProgress(
            message as {
              tool_use_id?: string;
              tool_name?: string;
              elapsed_time_seconds?: number;
            },
          );
          break;
        }

        case "tool_use_summary": {
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }
          state.handleToolUseSummary(
            message as {
              summary?: string;
              preceding_tool_use_ids?: string[];
            },
          );
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
              const inputTokens =
                (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0);
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
              state.ensureTextStarted();
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
            state.ensureTextStarted();
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
                  id?: string;
                  name?: string;
                  input?: Record<string, unknown>;
                }[];
              };
            }
          )?.message?.content;
          if (Array.isArray(content)) {
            state.handleAssistantMessage(content);
          }
          break;
        }

        case "user": {
          // Handle user messages with tool_result blocks
          if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
            break;
          }
          state.handleUserMessage(
            message as {
              message?: {
                content?: {
                  type: string;
                  tool_use_id?: string;
                  content?: unknown;
                  is_error?: boolean;
                }[];
              };
            },
          );
          break;
        }

        // ── Task/subagent events ──────────────────────────────────────
        case "system": {
          const subtype = (message as { subtype?: string }).subtype;

          if (subtype === "task_started") {
            state.handleTaskStarted(
              message as {
                task_id?: string;
                tool_use_id?: string;
                description?: string;
                prompt?: string;
              },
            );
          } else if (subtype === "task_progress") {
            state.handleTaskProgress(
              message as {
                task_id?: string;
                description?: string;
                usage?: {
                  total_tokens: number;
                  tool_uses: number;
                  duration_ms: number;
                };
                summary?: string;
              },
            );
          } else if (subtype === "task_notification") {
            state.handleTaskNotification(
              message as {
                task_id?: string;
                status?: string;
                summary?: string;
                usage?: {
                  total_tokens: number;
                  tool_uses: number;
                  duration_ms: number;
                };
              },
            );
          }
          break;
        }

        // ── Prompt suggestions ────────────────────────────────────────
        case "prompt_suggestion": {
          const suggestion = (message as { suggestion?: string }).suggestion;
          if (suggestion) {
            writer.write({
              type: "data-prompt-suggestion",
              data: { suggestion },
            });
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error("[claude-code] Stream error:", err);
    state.ensureTextStarted();
    writer.write({
      type: "error",
      errorText:
        err instanceof Error ? err.message : "Claude Code stream failed",
    });
  }

  // Close any open parts
  state.closeOpenParts();

  // Ensure text part is opened before closing it (AI SDK requirement)
  state.ensureTextStarted();
  writer.write({ type: "text-end", id: state.textPartId });
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

  // Flush any trailing text into completedParts
  state.flushTextPart();

  return {
    costUsd: totalCostUsd,
    usage,
    responseText: state.responseText,
    parts: state.completedParts,
    toolCallCount: state.toolCallCount,
    toolCallErrors: state.toolCallErrors,
  };
}
