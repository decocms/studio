/**
 * Decopilot Core Abstractions
 *
 * Conversation management types for AI assistants.
 *
 * Key concepts:
 * - ModelProvider: LLM connection abstraction
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { StudioChatMessage } from "@decocms/shared/chat-message";
import type { StudioChatTools } from "@decocms/shared/tools/chat-tools";

// ============================================================================
// Stream API Message Types
// ============================================================================

/**
 * Message type for chat - frontend and backend.
 * Validated messages from the client with proper Metadata typing.
 * Includes UITools for built-in tools (e.g. user_ask).
 * DataParts define custom data-* stream parts for tool annotations and subtask results.
 */
export type ChatMessage = StudioChatMessage<StudioChatTools>;

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
