import type { UIMessage, UIMessageChunk } from "ai";
import type {
  DecopilotMcpSource,
  DecopilotModelSources,
  DecopilotObjectStorageSource,
} from "./sources";

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
 *  Mirrors `apps/mesh/src/api/routes/decopilot/helpers.ts:ToolApprovalLevel`. */
export type ToolApprovalLevel = "auto" | "readonly";

/** Mode flag forwarded into harnesses. The CLI harnesses only care about
 *  "plan" (sets `isPlanMode` for read-only restrictions); decopilot
 *  interprets the rest internally. Mirrors
 *  `apps/mesh/src/harnesses/decopilot/mode-config.ts:CHAT_MODES`. */
export type ChatMode = "default" | "plan" | "web-search" | "gen-image";

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
  deepResearch?: ModelSelection;
}

/** UI-shape message a harness receives. Structurally compatible with the
 *  cluster's richer `ChatMessage` (which carries Metadata + builtin tool
 *  types). The package only needs the `parts` + `role` + `id` shape, which
 *  the AI SDK's generic `UIMessage` already provides. */
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

/** Pre-resolved per-user prompt data, read agent-side (mesh) before dispatch
 *  and rendered by the portable prompt builder. Each sub-block is independently
 *  optional; absent ⇒ the corresponding prompt section is skipped (desktop). */
export interface HarnessUserContext {
  recentThreads?: { total: number; threads: PromptThreadSummary[] };
  interests?: PromptInterest[];
  agents?: PromptAgentSummary[];
}

/** Input passed to every Harness.stream() call. Fully serializable except
 *  AbortSignal — designed so a future remote transport can JSON-serialize it
 *  over an HTTP+SSE wire (cancel becomes a separate RPC). */
export interface HarnessStreamInput {
  // ===== Identity =====
  threadId: string;
  runId: string;
  /** Opaque resume token, restored from prior `finish-message.providerMetadata`. */
  resumeSessionRef?: string;

  // ===== Conversation =====
  messages: ChatMessage[];

  // ===== Workspace =====
  /** Symbolic, logically-resolved working directory (see workspace-cwd.ts).
   *  Required. The daemon rebases non-"default" values onto its sandbox root. */
  workspace: { cwd: string };

  // ===== Models (already resolved: credential → key/headers, permissions checked) =====
  models: ModelsConfig;
  /** Resolved Decopilot model sources by slot. `thinking` is the canonical
   *  primary slot; optional slots let built-ins and auto-title use the
   *  credential already selected by the cluster without receiving cluster
   *  provider objects. Secret sources are serializable and may cross the link
   *  protocol; in-process model sources are local-only and must not cross it. */
  modelSources?: DecopilotModelSources;
  /** Resolved MCP source. HTTP sources are serializable; in-process clients are
   *  local-only and stripped before remote dispatch. */
  mcpSource?: DecopilotMcpSource;
  /** HTTP object-storage API source for runtimes that cannot access
   *  cluster-local object-storage clients. */
  objectStorageSource?: DecopilotObjectStorageSource;

  // ===== Tool gateway =====
  /** Serializable HTTP MCP endpoint the harness should connect to.
   *  In-process Decopilot may use DecopilotMcpSource(kind="in-process")
   *  outside the wire schema; such values must never cross the link
   *  protocol boundary. The Bearer token is a 1h-TTL temp key —
   *  `expiresAt` carries its absolute deadline so remote daemons can
   *  refresh proactively. */
  mcp: {
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
  };

  // ===== Mode (forwarded; each harness interprets independently) =====
  mode: ChatMode;

  // ===== Knobs =====
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  /**
   * Optional allowlist of model-facing tool names. When set, the assembled
   * toolset (MCP + built-ins) is filtered down to just these names before the
   * model sees it. `null`/absent = full toolset. Set by automations that pin a
   * specific subset of tools.
   */
  toolAllowlist?: string[] | null;

  // ===== Identity context (for prompts, audit) =====
  user: { id: string; email: string };
  organizationId: string;
  organizationSlug?: string;
  /** Optional project slug for agents pinned to a project. */
  projectSlug?: string;

  /** Loaded VirtualMcp entity (the agent definition). Decopilot reads metadata,
   *  connection list, and github-repo info from this; CLI harnesses use only `id`.
   *  Typed as a permissive bag in the package — the cluster passes its richer
   *  `VirtualMCPEntity` shape and TS accepts the widening. */
  virtualMcp: { id: string; metadata?: unknown; [k: string]: unknown };
  /** Convenience: same as `virtualMcp.id`. Kept separate to avoid forcing CLI
   *  harnesses to destructure the full entity. */
  agent: { id: string };

  // ===== Optional thread state =====
  branch?: string | null;
  taskId?: string;
  triggerId?: string;
  /** Current persisted thread title. Decopilot harness uses this to decide
   *  whether to run auto-title (only when title still equals the default). */
  currentThreadTitle?: string;

  // ===== Lifecycle =====
  /** Aborts when the consumer disconnects or the user cancels. */
  signal: AbortSignal;

  // ===== Trace propagation =====
  traceparent?: string;

  /**
   * Single-writer fence token for this run (spec §3.5). Minted by
   * prepareRun (Phase B) and included in every ingest append by the
   * desktop daemon. Absent on ws-path runs.
   */
  runFenceToken?: string;

  // ===== Pre-resolved prompt data (read agent-side before dispatch) =====
  /** Threads / interests / sibling-agents, pre-resolved by `prepareRun` so the
   *  portable prompt builder renders them without any `ctx.storage` reach-in.
   *  Absent on runs whose caller didn't pre-resolve (e.g. desktop) ⇒ the
   *  corresponding prompt blocks are skipped. */
  userContext?: HarnessUserContext;
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
 *  Re-declared here (mirroring `apps/mesh/src/core/harness-context.ts`) so
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
