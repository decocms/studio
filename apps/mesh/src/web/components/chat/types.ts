import type { ChatMessage } from "@/api/routes/decopilot/types";
export type { ChatMessage };
import type { UseChatHelpers } from "@ai-sdk/react";
import type { JSONContent } from "@tiptap/core";

// ============================================================================
// Chat Config Types
// ============================================================================

export interface ChatModelInfo {
  id: string;
  capabilities?: { vision?: boolean; text?: boolean; tools?: boolean };
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

export interface ChatModelsConfig {
  connectionId: string;
  thinking: ChatModelInfo;
  coding?: ChatModelInfo;
  fast?: ChatModelInfo;
}

export interface ChatAgentConfig {
  id: string | null;
  mode: "passthrough" | "smart_tool_selection" | "code_execution";
}

export interface ChatUserConfig {
  name?: string;
  avatar?: string;
}

// ============================================================================
// Tiptap Types
// ============================================================================

/**
 * Tiptap document type using DocumentType with our extension configuration
 * Uses TipTap's DocumentType matching our extension configuration
 * Makes attrs optional for JSON serialization compatibility
 */
export type TiptapDoc = {
  type: "doc";
  content: JSONContent[];
};

// Re-export JSONContent as TiptapNode for backwards compatibility
export type TiptapNode = JSONContent;

// ============================================================================
// Metadata Types
// ============================================================================

export interface Metadata {
  reasoning_start_at?: string | Date;
  reasoning_end_at?: string | Date;
  models?: ChatModelsConfig;
  agent?: ChatAgentConfig;
  user?: ChatUserConfig;
  created_at?: string | Date;
  thread_id?: string;
  title?: string;
  /** System prompt to prepend to messages at the transport layer */
  system?: string;
  /** Tiptap document for rich user input (includes prompt tags with resources) */
  tiptapDoc?: TiptapDoc;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    providerMetadata?: {
      [key: string]: unknown;
    };
  };
}

// ============================================================================
// Chat Threads Types
// ============================================================================

export interface Thread {
  id: string;
  title: string;
  created_at: string; // ISO string
  updated_at: string; // ISO string
  hidden?: boolean;
}

// ============================================================================
// Parent Thread Types
// ============================================================================

/**
 * Parent thread context for tracking message editing/branching flow
 * All fields refer to the parent message being branched from
 */
export interface ParentThread {
  /** Thread ID of the parent message */
  thread_id: string;
  /** ID of the parent message being branched from */
  messageId: string;
}

// ============================================================================
// Chat Message Types
// ============================================================================

export type ChatStatus = UseChatHelpers<ChatMessage>["status"];

// ============================================================================
// Tool Part Types
// ============================================================================

/**
 * Generic helper — DRY extraction for any built-in tool part.
 * Tool names in getBuiltInTools map to part types as `tool-${name}`.
 */
type ToolPart<T extends string> = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${T}` }
>;

export type UserAskToolPart = ToolPart<"user_ask">;
export type SubtaskToolPart = ToolPart<"subtask">;

// Compile-time guard: fails if SubtaskToolPart resolves to never
type _AssertSubtaskExists = SubtaskToolPart extends never
  ? [
      "ERROR: SubtaskToolPart is never — ensure getBuiltInTools includes subtask",
    ]
  : true;
const _assertSubtaskExists: _AssertSubtaskExists = true;
void _assertSubtaskExists;

// Compile-time guard: fails if UserAskToolPart resolves to never
type _AssertUserAskExists = UserAskToolPart extends never
  ? [
      "ERROR: UserAskToolPart is never — ensure getBuiltInTools includes user_ask",
    ]
  : true;
const _assertUserAskExists: _AssertUserAskExists = true;
void _assertUserAskExists;
