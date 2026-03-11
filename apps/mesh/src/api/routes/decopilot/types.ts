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
import type { ToolDefinition, UsageStats } from "@decocms/mesh-sdk";
import type { Metadata } from "@/web/components/chat/types";
import type { getBuiltInTools } from "./built-in-tools";

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
    };
    "tool-subtask-metadata": {
      usage: UsageStats;
      agent: string;
      models: ModelsConfig;
    };
    "thread-title": {
      title: string;
    };
  },
  {
    [K in keyof ReturnType<typeof getBuiltInTools>]: InferUITool<
      ReturnType<typeof getBuiltInTools>[K]
    >;
  }
>;

// ============================================================================
// Model Config Types
// ============================================================================

export interface ModelInfo {
  id: string;
  title: string;
  capabilities?: { vision?: boolean; text?: boolean; tools?: boolean };
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

export interface ModelsConfig {
  credentialId: string;
  thinking: ModelInfo;
  coding?: ModelInfo;
  fast?: ModelInfo;
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
