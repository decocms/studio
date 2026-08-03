import type { UIMessage } from "ai";

// Re-exported so downstream packages (@decocms/sandbox's SandboxClient, the
// web client) consume the AI-SDK chunk type via @decocms/shared without
// declaring a direct `ai` dependency — keeping a SINGLE hoisted `ai` instance
// (avoids the double-AI-SDK / broken-instanceof hazard).
export type { UIMessageChunk } from "ai";

/**
 * Harness domain/wire types — the shapes apps/api, apps/web, and
 * packages/sandbox all speak: harness ids, model slots, chat modes, and the
 * serializable dispatch input. Browser-safe; no cluster-only imports. The
 * cluster-side shapes (`ChatMessage` with metadata + tools) flow in via
 * structural compatibility: the cluster passes its richer types where these
 * expect a UIMessage, and TS accepts the widening.
 *
 * The host-side execution contracts (`Harness`, `HarnessContext`,
 * `HarnessFactory`) stay in apps/api/src/harnesses/lib — only the API runs one.
 */

/** Built-in harness identifiers. Open-ended on purpose — third-party harnesses
 *  may register additional ids later, but the v1 union covers what's in-tree. */
export type HarnessId = "decopilot" | "claude-code" | "codex";

/** Tool approval policy a harness should honor when forwarding to its CLI.
 *  Mirrors `apps/api/src/harnesses/lib/decopilot/mcp-tools.ts:ToolApprovalLevel`. */
export type ToolApprovalLevel = "auto" | "readonly";

/** Mode flag forwarded into harnesses. The CLI harnesses only care about
 *  "plan" (sets `isPlanMode` for read-only restrictions); decopilot
 *  interprets the rest internally. Mirrors
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

/** UI-shape message a harness receives. Structurally compatible with the
 *  cluster's richer `ChatMessage` (which carries Metadata + builtin tool
 *  types). The package only needs the `parts` + `role` + `id` shape, which
 *  the AI SDK's generic `UIMessage` already provides. */
export type ChatMessage = UIMessage;

export type HarnessWorkspace =
  | {
      cwd: "/repo";
      repo: {
        owner: string;
        name: string;
        connectedGithub: boolean;
      };
      branch: string | null;
    }
  | {
      cwd: null;
    };

export interface HarnessAgent {
  id: string;
  instructions?: string;
}

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

export interface HarnessStreamInput {
  threadId: string;
  userMessage: ChatMessage;
  harness: {
    sessionId?: string;
  };
  workspace: HarnessWorkspace;
  models: ModelsConfig;
  mcp: {
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
  };
  mode: ChatMode;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  toolAllowlist?: string[] | null;
  maxAgentSteps?: number;
  user: { id: string; email: string };
  organizationId: string;
  organizationSlug?: string;
  agent: HarnessAgent;
  triggerId?: string;
  currentThreadTitle?: string;
  signal: AbortSignal;
  traceparent?: string;
  runFenceToken?: string;
}
