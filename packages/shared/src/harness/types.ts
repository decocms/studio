import type { UIMessage } from "ai";

// Re-exported so downstream applications consume the AI-SDK chunk type via
// @decocms/shared without
// declaring a direct `ai` dependency — keeping a SINGLE hoisted `ai` instance
// (avoids the double-AI-SDK / broken-instanceof hazard).
export type { UIMessageChunk } from "ai";

/**
 * Decopilot domain types shared by the API and web client: model slots, chat
 * modes, and prompt context. Browser-safe; no cluster-only imports. The
 * API-side shapes (`ChatMessage` with metadata + tools) flow in via structural
 * compatibility: the API passes its richer types where these
 * expect a UIMessage, and TS accepts the widening.
 *
 * The hosted adapter stays in apps/api/src/harnesses/decopilot — only the API
 * runs the hosted Decopilot stream.
 */

/** Tool approval policy Decopilot enforces for tool calls.
 *  Mirrors `apps/api/src/harnesses/lib/decopilot/mcp-tools.ts:ToolApprovalLevel`. */
export type ToolApprovalLevel = "auto" | "readonly";

/** Mode flag interpreted by Decopilot. Mirrors
 *  `apps/api/src/harnesses/lib/decopilot/mode-config.ts:CHAT_MODES`. */
export type ChatMode =
  | "default"
  | "plan"
  | "web-search"
  | "deep-research"
  | "gen-image";

/** Per-model selection passed in the wire input. Every slot carries its own
 *  credentialId (decision D14) — there is no root credential. */
export interface ModelSelection {
  id: string;
  title?: string;
  provider?: string | null;
  /** The aiProviderKeys credential this slot resolves against. Dispatch
   *  defaults it to the chat credential when the client doesn't pin one. */
  credentialId: string;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
  /** Capability flags forwarded from the client model descriptor.
   *  `createLanguageModel` gates reasoning on `capabilities.reasoning !== false`. */
  capabilities?: { vision?: boolean; text?: boolean; reasoning?: boolean };
}

/** Slot-keyed model config. `coding` and `title` are gone (decisions D11/D12);
 *  `smart` is reserved for upcoming features. */
export interface ModelsConfig {
  thinking: ModelSelection;
  fast?: ModelSelection;
  smart?: ModelSelection;
  image?: ModelSelection;
  /** Quick web search (streaming, e.g. Perplexity Sonar) — powers the
   *  `web_search` built-in tool. */
  webSearch?: ModelSelection;
  /** Deep research (async/multi-source, e.g. Gemini Deep Research or
   *  Perplexity deep-research) — powers the `deep_research` built-in tool. */
  deepResearch?: ModelSelection;
}

/** UI-shape message Decopilot receives. Structurally compatible with the API's
 *  richer `ChatMessage` (which carries metadata + built-in tool types). The
 *  package only needs the `parts` + `role` + `id` shape, which the AI SDK's
 *  generic `UIMessage` already provides. */
export type ChatMessage = UIMessage;

/** One recent thread, pre-resolved agent-side for the prompt's history block.
 *  `updated_at` is an ISO string (the portable prompt builder formats the date
 *  label). Mirrors the fields `renderRecentThreadsSection` reads. */
export interface PromptThreadSummary {
  id: string;
  title: string;
  updated_at: string;
}

/** One durable interest, pre-resolved agent-side. Mirrors `storage.interests`'
 *  `Interest` shape, copied here so the package stays `@/`-free. */
export interface PromptInterest {
  title: string;
  summary: string;
}

/** One sibling agent, pre-resolved agent-side for the `<available-agents>`
 *  block. Mirrors `AgentsBlockEntry`. */
export interface PromptAgentSummary {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive" | "error";
}

/** Pre-resolved per-user prompt data, read agent-side (studio) before dispatch
 *  and rendered by the portable prompt builder. Each sub-block is independently
 *  optional; absent ⇒ the corresponding prompt section is skipped (desktop). */
export interface HarnessUserContext {
  recentThreads?: { total: number; threads: PromptThreadSummary[] };
  interests?: PromptInterest[];
  agents?: PromptAgentSummary[];
}
