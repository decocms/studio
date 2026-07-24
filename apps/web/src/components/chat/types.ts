import type { StudioChatMessage } from "@decocms/shared/chat-message";
import type { StudioChatTools } from "@decocms/shared/tools/chat-tools";
import type { UseChatHelpers } from "@ai-sdk/react";

export type ChatMessage = StudioChatMessage<StudioChatTools>;
export type {
  ChatAgentConfig,
  ChatMode,
  ChatUserConfig,
  Metadata,
} from "@decocms/shared/chat";
export type {
  TiptapDoc,
  TiptapNode,
} from "@decocms/shared/tiptap";

// ============================================================================
// Chat Config Types
// ============================================================================

export interface ChatModelInfo {
  id: string;
  capabilities?: {
    vision?: boolean;
    text?: boolean;
    tools?: boolean;
    reasoning?: boolean;
  };
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

// ============================================================================
// Parent Task Types
// ============================================================================

/**
 * Parent task context for tracking message editing/branching flow
 * All fields refer to the parent message being branched from
 */
export interface ParentTask {
  /** Task ID of the parent message (maps to thread_id DB column) */
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
