import type { TiptapDoc } from "./tiptap.ts";

export type SimpleModeTier =
  | "fast"
  | "smart"
  | "thinking"
  | "image"
  | "web_search"
  | "deep_research";

export type ToolApprovalLevel = "auto" | "readonly";

export type ChatMode =
  | "default"
  | "plan"
  | "web-search"
  | "deep-research"
  | "gen-image";

export interface ChatAgentConfig {
  id: string | null;
  /**
   * Display name of the agent this turn is addressed to. Set when an "@"
   * mention handed the turn to an agent, so later readers (the attribution UI,
   * the server's room-transcript relabelling) can name who spoke without a
   * lookup. Absent on single-agent threads, where the thread's agent is the
   * only speaker.
   */
  title?: string;
}

export interface ChatUserConfig {
  name?: string;
  avatar?: string;
}

/**
 * Metadata persisted and transported alongside a Studio thread message.
 */
export interface Metadata {
  reasoning_start_at?: string | Date;
  reasoning_end_at?: string | Date;
  /** Tier to use for model resolution on the backend */
  tier?: SimpleModeTier;
  agent?: ChatAgentConfig;
  user?: ChatUserConfig;
  created_at?: string | Date;
  thread_id?: string;
  /** Git branch to pin this thread to on creation. GitHub-linked vms only. */
  branch?: string | null;
  title?: string;
  /** System prompt to prepend to messages at the transport layer */
  system?: string;
  /**
   * Marks a system-initiated turn (e.g. the background-tool reaction nudge)
   * the model must see but the user must not.
   */
  internal?: boolean;
  /**
   * Set on a backgrounded subtask's run messages to the originating
   * `subtask` tool call's job id.
   */
  subtaskJobId?: string;
  /** Set on a turn auto-resumed after a backgrounded tool finished. */
  resumedFromBackground?: boolean;
  /** Tiptap document for rich user input. */
  tiptapDoc?: TiptapDoc;
  /** Agent mentions in this message, used to render delegation cards. */
  agentMentions?: Array<{ agentId: string; title: string; taskId?: string }>;
  /** Tool approval level at send time. */
  toolApprovalLevel?: ToolApprovalLevel;
  /** Decopilot mode, matching the stream schema's `mode` field. */
  mode?: ChatMode;
  /** @deprecated Old one-shot flags — prefer `mode`. */
  forceImageGeneration?: boolean;
  /** @deprecated Old one-shot flags — prefer `mode`. */
  forceWebSearch?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    /** End-of-turn context-window fill. */
    contextTokens?: number;
    /** AI SDK normalized cache token shorthand. */
    cachedInputTokens?: number;
    /** AI SDK normalized cache token breakdown. */
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
    };
    providerMetadata?: {
      [key: string]: unknown;
    };
  };
  /** Runtime-reported per-turn limits. */
  modelLimits?: {
    contextWindow: number;
    maxOutputTokens: number;
  };
}
