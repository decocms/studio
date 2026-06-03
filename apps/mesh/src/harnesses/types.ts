import type { UIMessage, UIMessageChunk, UIMessageStreamWriter } from "ai";

/**
 * Harness types — minimal definitions shared by every harness.
 *
 * These types intentionally avoid importing from cluster-only paths
 * (`@/core/*`, `@/storage/*`, `@/api/*`, etc.) so this file stays portable
 * into the desktop daemon's bundle. The cluster-side shapes (`ChatMessage`
 * with metadata + tools, full `StudioContext`, decopilot-only
 * `HarnessProcessLocal` internals) flow in via structural compatibility:
 * the cluster passes its richer types where the harness expects a
 * UIMessage / HarnessContext / unknown-extras-bag, and TS accepts the
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
 *  `apps/mesh/src/api/routes/decopilot/mode-config.ts:CHAT_MODES`. */
export type ChatMode = "default" | "plan" | "web-search" | "gen-image";

/** Per-model selection passed in the wire input. Cluster has a richer
 *  `ModelInfo` (capabilities, etc.); the package mirrors the minimal
 *  fields the harness package itself reads, plus `limits` which the
 *  cluster's decopilot run-stream reads for `maxOutputTokens`. */
export interface ModelSelection {
  id: string;
  title?: string;
  provider?: string | null;
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

export interface ModelsConfig {
  credentialId: string;
  thinking: ModelSelection;
  coding?: ModelSelection;
  fast?: ModelSelection;
  image?: ModelSelection & { credentialId: string };
  deepResearch?: ModelSelection & { credentialId: string };
}

/** UI-shape message a harness receives. Structurally compatible with the
 *  cluster's richer `ChatMessage` (which carries Metadata + builtin tool
 *  types). The package only needs the `parts` + `role` + `id` shape, which
 *  the AI SDK's generic `UIMessage` already provides. */
export type ChatMessage = UIMessage;

/** In-process-only extras that don't survive remote-dispatch serialization.
 *
 *  Decopilot consumes these; CLI harnesses ignore them entirely. The fields
 *  are produced by `prepareRun`'s outer scope on the cluster side (the
 *  `createUIMessageStream` execute callback's `writer`, the `RunRegistry`
 *  instance, etc.) and forwarded into the decopilot harness so the
 *  streamText loop can wire into the surrounding request-level state.
 *
 *  Strongly-typed members live on the cluster side. To keep the package
 *  portable, we type the structurally-deep cluster fields as `unknown` and
 *  let the cluster cast at the call site. CLI harnesses MUST NOT depend on
 *  any of these fields. */
export interface HarnessProcessLocal {
  /** UI message stream writer from the surrounding
   *  `createUIMessageStream({ execute: ({ writer }) => ... })`. Built-in
   *  tools push data chunks onto it; the decopilot stream merges its
   *  output via `writer.merge(...)`. */
  writer: UIMessageStreamWriter;

  /** Maps tool callId → tool output JSON. Mutated in place by the
   *  passthrough MCP layer (`toolsFromMCP`) as tools execute, then read
   *  back later. Shared between `assembleDecopilotTools` (which seeds it
   *  for the passthrough tools) and the built-in tools layer. */
  toolOutputMap: Map<string, string>;

  /** Screenshot images captured by `take_screenshot` during tool
   *  execution. Mutated in place by the built-in tool and by
   *  `prepareStep` inside `runDecopilotStream` (which splices images out
   *  to embed in the next user message). MUST be the same array
   *  reference passed to `assembleDecopilotTools` and `runDecopilotStream`. */
  pendingImages: unknown[];

  /** Thread id (equals `mem.thread.id`). Also lives on
   *  `HarnessStreamInput.threadId`; kept duplicated here so the harness
   *  doesn't have to assert that equivalence. */
  threadId: string;

  /** Initial value of `mem.thread.title` at request entry. Title
   *  generation only kicks off when this equals `DEFAULT_THREAD_TITLE`
   *  ("New chat") — the convention for an unrenamed thread. */
  currentThreadTitle: string;

  /** Run-registry abort signal for this run. Listened to by streamText
   *  (`abortSignal`), by genTitle (`abortSignal`), and queried from
   *  `onFinish`/`onAbort` callbacks to distinguish a real model finish
   *  from a user-cancel. */
  registrySignal: AbortSignal;

  /** The run-registry itself, used by `streamText.onFinish` to dispatch
   *  a deferred `FINISH` event when the HTTP consumer cut early but the
   *  model has now actually completed server-side. Cluster-only type;
   *  the package treats it as opaque. */
  runRegistry: unknown;

  /** Already-activated MeshProvider — the caller has resolved the
   *  credential id to a key/headers and called `ctx.aiProviders.activate`
   *  before invoking us. The decopilot harness rejects `null`; CLI
   *  harnesses don't read this field. Cluster-only type. */
  provider: unknown | null;

  /** Already-activated MeshProvider for the `generate_image` tool. May
   *  alias `provider` when the org's `image` tier uses the same credential
   *  as the chat (or no image tier is configured). Distinct activation
   *  when admin pairs image with a different key. Cluster-only type. */
  imageProvider?: unknown | null;

  /** Already-activated MeshProvider for the `web_search` tool's deep
   *  research path. May alias `provider` when the org's `web_research`
   *  tier uses the same credential as the chat (or no tier is
   *  configured). Decoupling lets web_search keep using Gemini's async
   *  research API even when the chat model is routed via LiteLLM/OpenRouter.
   *  Cluster-only type. */
  deepResearchProvider?: unknown | null;

  /** Already-activated provider/model used only for Decopilot auto-title.
   *  May differ from the chat provider when the org fast tier is backed by a
   *  different credential. Cluster-only type. */
  titleProvider?: unknown | null;
  titleModel?: unknown | null;

  /** Push callback for title-generation work. The streamText loop
   *  registers `titleHandle.promise.then(...)` as a pending op so the
   *  outer createUIMessageStream's `onFinish` can `await
   *  Promise.allSettled(pendingOps)` before tearing down the writer. */
  registerPendingOp: (op: Promise<void>) => void;

  /** Fired when the outer onFinish runs — used to gate the auto-title
   *  chunk emission against late title resolutions that arrive after
   *  the SSE channel has already been closed. */
  isStreamFinished: () => boolean;

  /** Called once per `streamText.onFinish` to report the cumulative
   *  totalUsage of the LLM call. The outer scope uses this to populate
   *  posthog's `chat_message_completed` event with input/output/total
   *  token counts. */
  onUsageAggregated: (totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;

  /** Called after the auto-titler commits a new title to the DB.
   *  Implementations emit a `decopilot.thread.status` SSE event so tabs
   *  that are NOT subscribed to this thread's `/stream` see the new title.
   *  Optional — callers that cannot supply sseHub (e.g. orphan-recovery
   *  path without a buffer) may omit it; the omission is safe and silent. */
  onTitleUpdated?: (title: string) => void | Promise<void>;

  /** Cluster-side cwd resolver for github-linked agents. Returns the
   *  per-branch sandbox workdir; CLI harnesses use this when running
   *  in-cluster. When undefined (or returns undefined), the harness
   *  falls back to `process.cwd()`. */
  resolveCwd?: () => Promise<string | undefined>;

  /** Per-turn buffer for coalescing `pages/<slug>.html` mirrors. The VM
   *  `write`/`edit` tools enqueue, the dispatch layer flushes once per
   *  step (via `pendingOps`). Cluster-only type; narrowed at the harness
   *  boundary. */
  htmlPageBuffer?: unknown;
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

  // ===== Models (already resolved: credential → key/headers, permissions checked) =====
  models: ModelsConfig;

  // ===== Tool gateway =====
  /** MCP endpoint the harness should connect to. In-process (decopilot,
   *  cluster-side claude-code/codex) uses `getInternalUrl()/mcp/virtual-mcp/<agentId>`;
   *  remote-cli (desktop daemon dispatch) uses the cluster's public URL.
   *  The Bearer token is a 1h-TTL temp key — `expiresAt` carries its
   *  absolute deadline so remote daemons can refresh proactively. */
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

  // ===== Identity context (for prompts, audit) =====
  user: { id: string; email: string };
  organizationId: string;
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

  /** Non-serializable extras for in-process dispatch. Remote dispatch
   *  strips this field — see `HarnessProcessLocal`. The decopilot
   *  harness REQUIRES this to be set and throws if missing; CLI harnesses
   *  ignore it. */
  processLocal?: HarnessProcessLocal;
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
 *  StudioContext and is only safe to read inside a harness that gates its
 *  cluster-side code path on `HarnessStreamInput.processLocal` (today,
 *  only decopilot does this).
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
