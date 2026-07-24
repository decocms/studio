import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { UIDataTypes, UIMessage, UITools } from "ai";
import type { Metadata } from "./chat.ts";

export interface ChatUsageStats {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ChatDataParts = UIDataTypes & {
  "tool-metadata": {
    annotations?: ToolAnnotations;
    latencyMs?: number;
    /** UTF-8 byte length of the JSON-serialized tool result. */
    outputBytes?: number;
  };
  "tool-subtask-metadata": {
    usage: ChatUsageStats;
    agent: string;
    /** Slot-keyed harness models (per-slot credentialId). */
    models: Record<string, unknown>;
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
   * what the model reads.
   */
  "trigger-event": {
    source: string;
    type: string;
    data: unknown;
  };
};

/**
 * The stable message shape transported between Studio clients and the API.
 * Servers may specialize `TOOLS`; browser consumers can use the default.
 */
export type StudioChatMessage<TOOLS extends UITools = UITools> = UIMessage<
  Metadata,
  ChatDataParts,
  TOOLS
>;
