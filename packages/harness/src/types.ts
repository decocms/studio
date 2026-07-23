import type { UIMessage, UIMessageChunk } from "ai";

// Re-exported so downstream packages (e.g. @decocms/sandbox's SandboxClient)
// consume the AI-SDK chunk type via @decocms/harness without declaring a direct
// `ai` dependency — keeping a SINGLE hoisted `ai` instance (avoids the
// double-AI-SDK / broken-instanceof hazard).
export type { UIMessageChunk } from "ai";

export { createSecretModelSource } from "./sources";
export type {
  DecopilotMcpSource,
  DecopilotModelSource,
  DecopilotModelSources,
  DecopilotObjectStorageSource,
  DecopilotSandboxSource,
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  McpClientLike,
  OpenMcpSourceOptions,
  OpenedMcpSource,
} from "./sources";

/**
 * Harness types — minimal definitions shared by every harness.
 *
 * These types intentionally avoid importing from cluster-only paths
 * (`@/core/*`, `@/storage/*`, `@/api/*`, etc.) so this file stays portable
 * into the desktop daemon's bundle. The cluster-side shapes (`ChatMessage`
 * with metadata + tools, full `StudioContext`) flow in via structural
 * compatibility: the cluster passes its richer types where the harness expects
 * a UIMessage / HarnessContext / unknown-extras-bag, and TS accepts the
 * widening.
 */

/** Built-in harness identifiers. Open-ended on purpose — third-party harnesses
 *  may register additional ids later, but the v1 union covers what's in-tree. */
export type HarnessId = "decopilot" | "claude-code" | "codex";

/** Tool approval policy a harness should honor when forwarding to its CLI.
 *  Mirrors `packages/harness/src/decopilot/mcp-tools.ts:ToolApprovalLevel`. */
export type ToolApprovalLevel = "auto" | "readonly";

/** Mode flag forwarded into harnesses. The CLI harnesses only care about
 *  "plan" (sets `isPlanMode` for read-only restrictions); decopilot
 *  interprets the rest internally. Mirrors
 *  `packages/harness/src/decopilot/mode-config.ts:CHAT_MODES`. */
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

/** A Harness produces a stream of UI message chunks for a conversation turn.
 *
 *  Implementations:
 *    - Decopilot: runs Vercel AI SDK `streamText` with built-in tools + MCP.
 *    - Claude Code: spawns the `claude` CLI via `ai-sdk-provider-claude-code`.
 *    - Codex: spawns `codex` app-server via `ai-sdk-provider-codex-cli`.
 *
 *  Output chunks are raw AI SDK `UIMessageChunk` — the shared stream layer
 *  extracts `providerMetadata` from the `finish-message` chunk to persist
 *  resume state. No side channels. */
export interface Harness {
  id: HarnessId;
  stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk>;
}

/** Narrow context interface every Harness factory takes. Cluster-specific
 *  surface (DB, vault, auth, MCP gateway internals) lives on the wider
 *  StudioContext; harnesses that need cluster-only services receive them
 *  through factory construction (captured in the closure), not through
 *  `HarnessStreamInput`.
 *
 *  The desktop's daemon constructs a HarnessContext directly to invoke
 *  `claudeCodeHarnessFactory.create()` / `codexHarnessFactory.create()`
 *  without depending on cluster-only modules.
 *
 *  Re-declared here (mirroring `apps/api/src/core/harness-context.ts`) so
 *  the package stays portable. The cluster's richer `StudioContext` is
 *  structurally assignable to this shape. */
export interface HarnessContext {
  tracer: import("@opentelemetry/api").Tracer;
  meter: import("@opentelemetry/api").Meter;
  metadata: {
    threadId?: string;
    orgId?: string;
    userId?: string;
  };
  /** Optional — only decopilot uses this; CLI harnesses never read it. */
  aiProviders?: {
    activate(
      credentialId: string,
      organizationId: string,
    ): Promise<unknown | null>;
  };
}

/** A factory binds in-process dependencies (HarnessContext) into a Harness
 *  instance. The registry stores factories rather than singletons because
 *  the harnesses need per-request access to storage, providers, and tracing
 *  via `ctx`. Keeping ctx out of `HarnessStreamInput` means the input shape
 *  stays serializable for a future remote transport. */
export interface HarnessFactory {
  id: HarnessId;
  create(ctx: HarnessContext): Harness;
}
