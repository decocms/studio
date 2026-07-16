/**
 * Decopilot Core Abstractions
 *
 * Conversation management types for AI assistants.
 *
 * Key concepts:
 * - ModelProvider: LLM connection abstraction
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { InferUITool, UIMessage } from "ai";
import type { ToolDefinition, UsageStats } from "@decocms/studio-sdk";
import type { Metadata } from "@/web/components/chat/types";
import type { BuiltInToolSet } from "@/harnesses/decopilot/built-in-tools";
import type { ModelsConfig as HarnessModelsConfig } from "@decocms/harness/types";

// ============================================================================
// Stream API Message Types
// ============================================================================

/**
 * Message type for chat - frontend and backend.
 * Validated messages from the client with proper Metadata typing.
 * Includes UITools for built-in tools (e.g. user_ask).
 * DataParts define custom data-* stream parts for tool annotations and subtask results.
 */
export type ChatMessage = UIMessage<
  Metadata,
  {
    "tool-metadata": {
      annotations?: NonNullable<ToolDefinition["annotations"]>;
      latencyMs?: number;
      /** UTF-8 byte length of the JSON-serialized tool result. */
      outputBytes?: number;
    };
    "tool-subtask-metadata": {
      usage: UsageStats;
      agent: string;
      /** Slot-keyed harness models (per-slot credentialId). */
      models: HarnessModelsConfig;
    };
    "thread-title": {
      title: string;
    };
    "generate-image": {
      toolCallId: string;
      images: Array<{ base64: string; mediaType: string }>;
      prompt: string;
    };
    "web-search": {
      delta: string;
    };
    /**
     * Structured trigger payload for an event/webhook-fired automation run.
     * UI-only — dropped by `convertToModelMessages`; the sibling text part is
     * what the model reads. Rendered as a dedicated card on the user message.
     */
    "trigger-event": {
      source: string;
      type: string;
      data: unknown;
    };
  },
  {
    [K in keyof BuiltInToolSet]: InferUITool<BuiltInToolSet[K]>;
  }
>;

// ============================================================================
// Model Config Types
// ============================================================================

import type { ModelInfo } from "@decocms/harness/decopilot/model-info";

export type { ModelInfo };

/** CLIENT request shape: root credentialId for the chat model. Dispatch
 *  normalizes this into the per-slot harness/wire `ModelsConfig`
 *  (`@/harnesses`) before invoking a harness. No `coding` slot (D11). */
export interface ModelsConfig {
  credentialId: string;
  thinking: ModelInfo;
  fast?: ModelInfo;
  image?: ModelInfo & { credentialId: string };
  webSearch?: ModelInfo & { credentialId: string };
  deepResearch?: ModelInfo & { credentialId: string };
}

// ============================================================================
// ModelProvider - LLM connection abstraction
// ============================================================================

/**
 * A ModelProvider creates language models from MCP connections.
 */
export interface ModelProvider {
  /** Thinking model - backbone for the agentic loop */
  readonly thinkingModel: LanguageModelV2;

  /** Coding model - good for code generation */
  readonly codingModel?: LanguageModelV2;

  /** Fast model - cheap model for simple tasks */
  readonly fastModel?: LanguageModelV2;

  /** Provider key ID that provides these models */
  readonly providerKeyId: string;
}

// ============================================================================
// Message Processing Types
// ============================================================================

/**
 * Limits for model output
 */
export interface ModelLimits {
  /** Maximum tokens in context window */
  contextWindow?: number;

  /** Maximum tokens in output */
  maxOutputTokens?: number;
}
