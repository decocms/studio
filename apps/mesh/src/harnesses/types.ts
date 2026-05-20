import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import type { ChatMessage, ModelsConfig } from "../api/routes/decopilot/types";
import type { ChatMode } from "../api/routes/decopilot/mode-config";
import type { ToolApprovalLevel } from "../api/routes/decopilot/helpers";

/** Built-in harness identifiers. Open-ended on purpose — third-party harnesses
 *  may register additional ids later, but the v1 union covers what's in-tree. */
export type HarnessId = "decopilot" | "claude-code" | "codex";

/** In-process-only extras that don't survive remote-dispatch serialization.
 *
 *  Decopilot consumes these; CLI harnesses ignore them entirely. The fields
 *  are produced by `prepareRun`'s outer scope (the `createUIMessageStream`
 *  execute callback's `writer`, the `RunRegistry` instance, etc.) and
 *  forwarded into the decopilot harness so the streamText loop can wire
 *  into the surrounding request-level state.
 *
 *  In a future remote-dispatch pass this field is stripped before the
 *  payload crosses the wire — the in-process extras simply have no remote
 *  equivalent (the writer's UI message stream layer would live on the
 *  caller side). The decopilot harness MUST refuse to run without it; the
 *  CLI harnesses MUST NOT depend on any of these fields. */
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
   *  reference passed to `assembleDecopilotTools` and `runDecopilotStream`
   *  — otherwise the screenshot tool writes to one array and
   *  `prepareStep` reads from another, and the images never reach the
   *  model. */
  pendingImages: import("./decopilot/built-in-tools/take-screenshot").PendingImage[];

  /** Thread id (equals `mem.thread.id`). Also lives on
   *  `HarnessStreamInput.threadId`; kept duplicated here so the harness
   *  doesn't have to assert that equivalence. */
  threadId: string;

  /** Initial value of `mem.thread.title` at request entry. Title
   *  generation only kicks off when this equals `DEFAULT_THREAD_TITLE`
   *  ("New chat") — the convention for an unrenamed thread.
   *
   *  Identical to `HarnessStreamInput.currentThreadTitle` in well-formed
   *  callers; the duplication exists because the surrounding stream-core
   *  code loads the title from the `Memory` object today. */
  currentThreadTitle: string;

  /** Run-registry abort signal for this run. Listened to by streamText
   *  (`abortSignal`), by genTitle (`abortSignal`), and queried from
   *  `onFinish`/`onAbort` callbacks to distinguish a real model finish
   *  from a user-cancel. */
  registrySignal: AbortSignal;

  /** The run-registry itself, used by `streamText.onFinish` to dispatch
   *  a deferred `FINISH` event when the HTTP consumer cut early but the
   *  model has now actually completed server-side. */
  runRegistry: import("../api/routes/decopilot/run-registry").RunRegistry;

  /** Already-activated MeshProvider — the caller has resolved the
   *  credential id to a key/headers and called `ctx.aiProviders.activate`
   *  before invoking us. The decopilot harness rejects `null`; CLI
   *  harnesses don't read this field. */
  provider: import("../ai-providers/types").MeshProvider | null;

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
  /** MCP endpoint the harness should connect to. Today this is the in-process
   *  `getInternalUrl()/mcp/virtual-mcp/<agentId>`; in a future remote-dispatch
   *  pass it will be the public mesh URL. The Bearer token is a 1h-TTL temp key. */
  mcp: { url: string; headers: Record<string, string> };

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
   *  connection list, and github-repo info from this; CLI harnesses use only `id`. */
  virtualMcp: VirtualMCPEntity;
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

/** A factory binds in-process dependencies (MeshContext) into a Harness
 *  instance. The registry stores factories rather than singletons because
 *  the harnesses need per-request access to storage, providers, and tracing
 *  via `ctx`. Keeping ctx out of `HarnessStreamInput` means the input shape
 *  stays serializable for a future remote transport. */
export interface HarnessFactory {
  id: HarnessId;
  create(ctx: import("../core/mesh-context").MeshContext): Harness;
}
