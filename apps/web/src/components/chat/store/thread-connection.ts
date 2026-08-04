/**
 * ThreadConnection — self-contained per-thread data + transport.
 *
 * Owns:
 *   • one persistent SSE GET /stream loop (reconnect+backoff)
 *   • one-shot POST /messages for sends + continuations
 *   • a single `messages` Store that's the only source of truth
 *   • `status`, `finishReason`, `hasMoreOlder`, `isFetchingOlder` Stores
 *     read by the React layer
 *
 * Lifecycle:
 *   constructor → bootstrap() opens the SSE and calls
 *   COLLECTION_THREAD_MESSAGES_LIST in parallel to seed the initial page
 *   (latest 5 messages). The SSE delivers UIMessageChunk events that fold
 *   into the messages list via mergeAndSort. Chunks arriving before the
 *   initial page resolves are buffered and drained afterwards.
 *   dispose() aborts everything.
 *
 * Mutation:
 *   Exactly one entry point: submit(action). Three action kinds:
 *     • { kind: "message",    message }              — new user turn
 *     • { kind: "toolOutput", toolCallId, output }   — tool call response
 *     • { kind: "approval",   approvalId, approved } — approval response
 *   Each one patches `messages` synchronously and POSTs the last message
 *   to /messages. finishReason is cleared synchronously on every submit
 *   so prior-turn "Response incomplete" banners don't flash through.
 *
 *   No silent no-ops: if a toolOutput / approval target isn't found in
 *   the current `messages`, submit() throws.
 *
 * Server reconciliation:
 *   On every SSE reconnect the connection re-fetches the latest page via
 *   COLLECTION_THREAD_MESSAGES_LIST and merges via mergeAndSort. The
 *   merge is upsert-by-id then sort by (created_at, id), so optimistic
 *   local rows and in-flight streaming rows are preserved correctly.
 */

import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolApprovalLevel } from "@/hooks/use-preferences";
import type { SimpleModeTier } from "@decocms/shared/organization/schema";
import { Store } from "./store-primitive";
import { extractToolErrorMessage } from "./mcp-utils";
import { guardToolInvariant } from "./tool-invariant-guard";
import type { ChatMode } from "../types";
import { toast } from "sonner";
import {
  advanceRunStatusStage,
  isRunStatusControlChunk,
  parseRunStatusStageChunk,
  type RunStatusStage,
} from "../run-status";

export { Store };

// ─── Request options (wire payload alongside `messages`) ─────────────────────

export interface RequestOptions {
  tier: SimpleModeTier;
  mode: ChatMode;
  toolApprovalLevel: ToolApprovalLevel;
  /** Synthesized into a `role: "system"` message at POST time. */
  system?: string;
  agent?: { id: string };
  branch?: string | null;
  thread_id?: string;
  /**
   * Optional pins sent on first message. The server persists them onto the
   * thread row and ignores them on subsequent messages.
   */
  sandboxProviderKind?: "agent-sandbox";
  harnessId?: "decopilot";
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type ConnStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "submitted" }
  | { kind: "streaming" }
  | { kind: "error"; error: Error };

// ─── Submit actions ──────────────────────────────────────────────────────────

export type SubmitAction =
  | { kind: "message"; message: UIMessage }
  | {
      kind: "toolOutput";
      toolCallId: string;
      output: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
    }
  | {
      kind: "approval";
      approvalId: string;
      approved: boolean;
      reason?: string;
    };

// ─── Hand-rolled emitter ─────────────────────────────────────────────────────
// `Store<T>` lives in ../store/store-primitive; re-exported above for callers
// that import it from this module.

// ─── Observer ────────────────────────────────────────────────────────────────

export interface ThreadObserver {
  onData?: (chunk: Extract<UIMessageChunk, { type: `data-${string}` }>) => void;
  onToolCall?: (event: {
    toolCall: { toolCallId: string; toolName: string; input: unknown };
  }) => void;
  onFinish?: (
    msg: UIMessage,
    messages: UIMessage[],
    finishReason?: string,
  ) => void;
  onError?: (err: Error) => void;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const CLEAN_RECONNECT_DELAY_MS = 50;
/** G1: Maximum time (ms) to wait for the POST /messages response. The POST is
 *  idempotency-keyed (workflowID), so a timeout-then-retry is safe. */
const POST_TIMEOUT_MS = 60_000;

// Browser uses rAF for chunk-coalescing; tests run under Bun where rAF is absent.
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0) as unknown as number;
const cancelFrame: (id: number) => void =
  typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame
    : (id) => clearTimeout(id);

/**
 * Apply a SubmitAction to a messages list. Returns the next list, or null
 * if the action's target (toolCallId / approvalId) wasn't found. Callers
 * surface null as an error — no silent no-ops.
 */
function applyLocally(
  prev: UIMessage[],
  action: SubmitAction,
): UIMessage[] | null {
  if (action.kind === "message") {
    // Stamp a top-level `created_at` the moment the user submits. Without it the
    // optimistic user row reads as +Infinity in `readTimestamp`/`mergeAndSort`,
    // while the assistant reply gets a finite timestamp (run-start
    // `metadata.created_at`, or its finish anchor) — so the reply sorts AHEAD of
    // the user row that triggered it. The turn then renders empty ("No response
    // was generated") with its answer detached under the next turn, until a
    // refetch brings the DB `created_at`.
    //
    // The just-submitted message is the newest in the thread, so stamp it
    // strictly after every existing finite timestamp — not a bare `now`, which
    // can tie (to the millisecond) with a frozen assistant just anchored by
    // stop(); the role tiebreak would then wrongly sort the new user ahead of
    // that earlier assistant. A persisted refetch (incoming carries the DB
    // `created_at`) overwrites this via `preserveCreatedAt`. No-op if a
    // `created_at` is already present.
    const msg = action.message as UIMessage & { created_at?: string };
    if (msg.created_at != null) return [...prev, msg];
    let maxMs = 0;
    for (const m of prev) {
      const ts = (m as { created_at?: string | number | Date }).created_at;
      if (ts == null) continue;
      const t = new Date(ts).getTime();
      if (Number.isFinite(t) && t > maxMs) maxMs = t;
    }
    const ms = Math.max(Date.now(), maxMs + 1);
    return [
      ...prev,
      { ...msg, created_at: new Date(ms).toISOString() } as UIMessage,
    ];
  }
  // toolOutput / approval — locate the part by id on any assistant message.
  // The newest occurrence wins (the same toolCallId shouldn't appear twice
  // but we scan right-to-left so the freshest match is hit).
  for (let i = prev.length - 1; i >= 0; i--) {
    const msg = prev[i];
    if (!msg || msg.role !== "assistant") continue;
    const partIdx = findTargetPartIndex(msg.parts, action);
    if (partIdx === -1) continue;
    const part = msg.parts[partIdx];
    if (!part) continue;
    const nextPart = patchPart(part, action);
    if (!nextPart) continue;
    const nextParts = [...msg.parts];
    nextParts[partIdx] = nextPart;
    const nextMsgs = [...prev];
    nextMsgs[i] = { ...msg, parts: nextParts };
    return nextMsgs;
  }
  return null;
}

type ToolLikePart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function isToolLikePart(
  part: UIMessage["parts"][number],
): part is ToolLikePart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function findTargetPartIndex(
  parts: UIMessage["parts"],
  action: Exclude<SubmitAction, { kind: "message" }>,
): number {
  if (action.kind === "toolOutput") {
    return parts.findIndex(
      (p) => isToolLikePart(p) && p.toolCallId === action.toolCallId,
    );
  }
  return parts.findIndex(
    (p) =>
      isToolLikePart(p) &&
      p.state === "approval-requested" &&
      p.approval?.id === action.approvalId,
  );
}

function patchPart(
  part: UIMessage["parts"][number],
  action: Exclude<SubmitAction, { kind: "message" }>,
): UIMessage["parts"][number] | null {
  if (!isToolLikePart(part)) return null;
  if (action.kind === "toolOutput") {
    return {
      ...part,
      state: action.state ?? "output-available",
      output: action.output,
      errorText: action.errorText,
    } as ToolLikePart;
  }
  return {
    ...part,
    state: "approval-responded",
    approval: {
      id: action.approvalId,
      approved: action.approved,
      ...(action.reason ? { reason: action.reason } : {}),
    },
  } as ToolLikePart;
}

function describe(action: SubmitAction): string {
  if (action.kind === "message") return `message id=${action.message.id}`;
  if (action.kind === "toolOutput")
    return `toolOutput toolCallId=${action.toolCallId}`;
  return `approval approvalId=${action.approvalId}`;
}

// ─── ThreadConnection ────────────────────────────────────────────────────────

interface ThreadConnectionOptions {
  client?: MCPClient | null;
  /**
   * Skip the per-thread SSE and render from persisted parts only.
   *
   * A sandbox-hosted harness (`claude-code`) is a batch job: it runs its loop in
   * the pod and flushes whole turns on the SDK's `result`, so there is no
   * token-by-token stream to follow. Holding an SSE open per thread to watch for
   * one terminal write buys nothing — the org-level `/watch` already reports the
   * thread's status change, and the transcript comes from
   * COLLECTION_THREAD_MESSAGES_LIST like any other page load.
   */
  batch?: boolean;
}

export class ThreadConnection {
  readonly key: string;

  /** Single source of truth. Seeded from COLLECTION_THREAD_MESSAGES_LIST on
   *  load, mutated locally on submit, mutated chunk-by-chunk during SSE
   *  streaming. */
  readonly messages = new Store<UIMessage[]>([]);
  readonly status = new Store<ConnStatus>({ kind: "loading" });
  readonly finishReason = new Store<string | null>(null);
  readonly runStatusStage = new Store<RunStatusStage | null>(null);
  readonly hasMoreOlder = new Store<boolean>(false);
  readonly isFetchingOlder = new Store<boolean>(false);

  observer: ThreadObserver | null = null;

  /** Test-only escape hatch. Don't call from production. */
  readonly abort = new AbortController();

  // Demuxer state for the persistent SSE.
  private subController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  private pendingFinishReason: string | undefined = undefined;
  private discardOnClose = false;
  private inflightPost: AbortController | null = null;
  /**
   * After a manual stop(), drop chunks until the next `start` chunk so late
   * text-deltas / finish events from the cancelled run don't open a fresh
   * substream and land on a new assistant message after any user turn the
   * user has queued in the meantime.
   */
  private waitingForNewRun = false;
  private acceptPreStartRunStatus = true;
  /** `start` chunk opened a new assistant turn — don't seed the prior one. */
  private freshRunSubstream = false;
  private client: MCPClient | null;
  /** See `ThreadConnectionOptions.batch` — no SSE, persisted parts only. */
  private readonly batch: boolean;
  private serverFetchedCount = 0;
  private readonly pageSize = 5;
  /**
   * Chunk buffer: `[]` means "boot, buffering"; `null` means "ready, fold
   * chunks live". Chunks arriving before loadInitialPage resolves are queued
   * here and replayed through `handleChunk` after the page lands.
   */
  private chunkBuffer: UIMessageChunk[] | null = [];

  /**
   * Resolves once the initial page load settles (success, error, or
   * null-client fallback). Consumers `use()` this to suspend the chat tree
   * via the `<Suspense fallback={<Chat.Skeleton />}>` boundary in
   * side-panel-chat.tsx so the first paint isn't an empty message list.
   * Resolves only — never rejects; error states are surfaced through
   * `status` so the UI can render an inline error instead of an
   * ErrorBoundary fallback.
   */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    readonly orgSlug: string,
    readonly threadId: string,
    opts: ThreadConnectionOptions = {},
  ) {
    this.key = `${orgSlug}::${threadId}`;
    this.client = opts.client ?? null;
    this.batch = opts.batch ?? false;
    this.ready = new Promise<void>((res) => {
      this.resolveReady = res;
    });
    void this.bootstrap();
  }

  dispose(): void {
    this.abort.abort();
  }

  // ── Public mutator (single entry point) ─────────────────────────────────

  async submit(action: SubmitAction, opts: RequestOptions): Promise<void> {
    // Always clear stale finishReason synchronously so the prior-turn
    // "Response incomplete" warning doesn't flash through during the
    // POST → first-chunk round trip.
    this.finishReason.set(null);

    const next = applyLocally(this.messages.get(), action);
    if (!next) {
      throw new Error(`submit: target not found for ${describe(action)}`);
    }
    // Same sort pass refresh uses (mergeAndSort + DB `created_at`). Without
    // it, an in-flight SSE assistant row can sit above the user we just
    // appended because foldSubStream only upserts by id.
    this.messages.set(mergeAndSort(next, []));
    this.acceptPreStartRunStatus = true;

    // A new user turn always POSTs. For approval / toolOutput actions, only
    // POST once the assistant turn has no remaining client-side resolutions
    // (other pending approvals or unresolved local tool inputs). The two
    // AI SDK predicates together cover both shapes.
    const shouldPost =
      action.kind === "message" ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: next }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages: next });

    if (!shouldPost) return;

    const last = next.at(-1);
    if (!last) {
      // Can't happen — applyLocally returned non-null so the list has ≥1 item.
      this.status.set({ kind: "ready" });
      return;
    }

    this.runStatusStage.set("sending");
    this.status.set({ kind: "submitted" });

    const abort = new AbortController();
    this.inflightPost = abort;
    try {
      await this.post(last, opts, abort.signal);
    } catch (err) {
      this.clearRunStatusStage();
      // stop() aborts `abort.signal` and already reset status to "ready"
      // synchronously; the POST's rejection lands here asynchronously after
      // that. Don't clobber the deliberate cancel with an error state.
      if (abort.signal.aborted) return;
      const e = err instanceof Error ? err : new Error(String(err));
      this.failTo(e);
    } finally {
      if (this.inflightPost === abort) this.inflightPost = null;
    }
  }

  /**
   * Queue a user message behind the active run: POST it to the thread gate
   * WITHOUT touching the running turn's status display (no
   * `status`/`runStatusStage` change — that belongs to the turn already
   * streaming) and WITHOUT rendering it in the body — tray-only until
   * dispatch; the caller stashes the message for the dispatch-time flip.
   * Throws if the POST fails so the caller can surface the error.
   */
  async enqueue(message: UIMessage, opts: RequestOptions): Promise<void> {
    await this.post(message, opts, undefined, true);
  }

  /** Append one message to the local body store (dispatch-time tray→body flip). */
  applyLocalMessage(message: UIMessage): void {
    // `applyLocally` can only return null for toolOutput/approval actions
    // whose target isn't found — a "message" action always appends. The
    // `?? cur` fallback exists purely to satisfy the Store<UIMessage[]>
    // updater's return type.
    //
    // Route through the same mergeAndSort pass submit() uses: its Map-by-id
    // rebuild dedupes against a copy of this row that a server refetch (e.g.
    // an SSE-reconnect refetchLatestPage) may have already merged into the
    // body — without it the flip would append a SECOND row with the same id.
    this.messages.update((cur) => {
      const next = applyLocally(cur, { kind: "message", message }) ?? cur;
      return mergeAndSort(next, []);
    });
  }

  /** Drop a message from the local store (used when a queued turn is removed). */
  removeLocalMessage(messageId: string): void {
    this.messages.update((cur) => cur.filter((m) => m.id !== messageId));
  }

  stop(): void {
    this.inflightPost?.abort();
    const s = this.status.get();
    if (s.kind === "submitted" || s.kind === "streaming") {
      this.status.set({ kind: "ready" });
    }
    this.clearRunStatusStage();
    this.acceptPreStartRunStatus = false;
    // Freeze the in-flight assistant message at its current state and gate
    // every subsequent chunk on a fresh `start` boundary. Without this, the
    // cancel's racing tail chunks (or a server-side replay across an SSE
    // reconnect) would create a new assistant message that lands after any
    // user turn the user queues between Stop and the next run.
    if (this.subController) {
      this.forceCloseSubStream(true);
    }
    // Anchor the frozen assistant so mergeAndSort on the next submit doesn't
    // pull a timestamp-less user row ahead of it (role tiebreak or +Infinity).
    this.messages.update((msgs) => {
      const last = msgs.at(-1);
      if (last?.role !== "assistant") return msgs;
      const row = last as UIMessage & { created_at?: string };
      if (row.created_at != null) return msgs;
      const anchored = {
        ...last,
        created_at: new Date().toISOString(),
      } as UIMessage;
      return [...msgs.slice(0, -1), anchored];
    });
    this.waitingForNewRun = true;
  }

  clearError(): void {
    const s = this.status.get();
    if (s.kind === "error") this.status.set({ kind: "ready" });
  }

  // ── Internal: bootstrap ─────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    // Batch threads have no stream to follow: load the transcript and stop.
    // `loadInitialPage` resolves `ready` on every terminal path, so the chat
    // unsuspends exactly as it does for a streaming thread.
    if (this.batch) {
      await this.loadInitialPage();
      return;
    }
    // Initial-page fetch and SSE loop run concurrently. Chunks arriving
    // before the page resolves are queued via `chunkBuffer` and drained
    // through `handleChunk` after the page lands.
    void this.loadInitialPage();
    await this.runSseLoop();
  }

  private async loadInitialPage(): Promise<void> {
    // Yield one microtask so the constructor finishes and callers can
    // observe the initial { kind: "loading" } status synchronously.
    await Promise.resolve();
    if (!this.client) {
      // Test harness / no MCP — flip to ready immediately and dispatch
      // chunks live. The chat UI is usable with chunks alone.
      if (this.status.get().kind === "loading") {
        this.status.set({ kind: "ready" });
      }
      this.drainChunkBuffer();
      this.resolveReady();
      return;
    }
    try {
      const page = await this.fetchLatestPage(
        "COLLECTION_THREAD_MESSAGES_LIST failed",
      );
      if (page.kind === "aborted") {
        this.resolveReady();
        return;
      }
      if (page.kind === "error") {
        throw new Error(page.message);
      }
      const items = page.items;
      this.messages.update((curr) => mergeAndSort(curr, items));
      // Re-surface a settled turn's finish reason (e.g. the step-limit
      // "tool-calls" pause) so the "Response incomplete" banner persists
      // across reloads. Live runs set this from the stream's finish chunk;
      // here we seed it from the persisted finish anchor when none is set.
      if (this.finishReason.get() === null) {
        const last = this.messages.get().at(-1);
        const fr =
          last?.role === "assistant"
            ? (last.metadata as { finishReason?: string } | undefined)
                ?.finishReason
            : undefined;
        if (fr) this.finishReason.set(fr);
      }
      this.serverFetchedCount = items.length;
      this.hasMoreOlder.set(page.hasMore ?? false);
      if (this.status.get().kind === "loading") {
        this.status.set({ kind: "ready" });
      }
      this.drainChunkBuffer();
    } catch (err) {
      this.failTo(err instanceof Error ? err : new Error(String(err)));
      // G3: drain the chunk buffer even on failure so live SSE chunks that
      // arrived while the initial page was in-flight aren't stuck forever.
      // Without this, chunkBuffer stays non-null after the catch branch and
      // handleChunk keeps buffering indefinitely — the thread is stuck.
      // Subsequent successful SSE chunks fold live; dedupe-by-id handles
      // any overlap with rows from a later successful loadInitialPage.
      this.drainChunkBuffer();
    } finally {
      this.resolveReady();
    }
  }

  /**
   * Shared fetch core for the three latest-page readers (`loadInitialPage`,
   * `refetchLatestPage`, `reconcileFromServer`): one
   * COLLECTION_THREAD_MESSAGES_LIST call for the newest `pageSize` rows plus
   * the structuredContent unwrap. Callers own everything after the fetch —
   * how to merge (`mergeAndSort` vs `reconcileLatestPage`), how `hasMore`
   * feeds `hasMoreOlder`, and whether a tool error throws (initial load) or
   * is logged (background refetches) — with the tool-error fallback label
   * kept per-caller via `errorFallback`.
   */
  private async fetchLatestPage(
    errorFallback: string,
  ): Promise<
    | { kind: "ok"; items: UIMessage[]; hasMore?: boolean }
    | { kind: "aborted" }
    | { kind: "error"; message: string }
  > {
    if (!this.client) return { kind: "aborted" };
    const result = await this.client.callTool({
      name: "COLLECTION_THREAD_MESSAGES_LIST",
      arguments: {
        thread_id: this.threadId,
        limit: this.pageSize,
        offset: 0,
        orderBy: [{ field: ["created_at"], direction: "desc" }],
      },
    });
    if (this.abort.signal.aborted) return { kind: "aborted" };
    if ((result as { isError?: boolean }).isError) {
      return {
        kind: "error",
        message: extractToolErrorMessage(result, errorFallback),
      };
    }
    const payload = ((result as { structuredContent?: unknown })
      .structuredContent ?? result) as {
      items?: UIMessage[];
      hasMore?: boolean;
    };
    return {
      kind: "ok",
      items: payload.items ?? [],
      hasMore: payload.hasMore,
    };
  }

  /**
   * Refresh the latest page after an SSE reconnect. Same args as the initial
   * load; the merge (upsert-by-id + sort by created_at) absorbs any overlap
   * with rows already in `messages` and preserves any optimistic-local rows
   * the server hasn't seen yet.
   *
   * Errors are logged but not surfaced — the next reconnect retries.
   */
  private async refetchLatestPage(): Promise<void> {
    if (!this.client) return;
    try {
      const page = await this.fetchLatestPage("tool error");
      if (page.kind === "aborted") return;
      if (page.kind === "error") {
        console.warn("[chat-store] refetchLatestPage:", page.message);
        return;
      }
      this.messages.update((curr) => mergeAndSort(curr, page.items));
      if (page.hasMore !== undefined) {
        this.hasMoreOlder.set(page.hasMore);
      }
    } catch (err) {
      console.warn("[chat-store] refetchLatestPage failed:", err);
    }
  }

  /**
   * Reconcile the live store against the server's authoritative latest page.
   *
   * Unlike `refetchLatestPage` (a plain merge used on reconnect), this DROPS
   * stale in-flight assistant rows that the live fold left behind — the
   * transient, client-id assistant a dequeued queued turn folds into, which
   * clobbers the prior reply and can't dedupe against its persisted id (see
   * `reconcileLatestPage`). Called on a run terminal while the thread's message
   * queue is active, so the body catches up to DB truth (the dequeued turn's
   * user bubble + reply) without a manual reload. Public: the chat-context
   * observer drives it off the SSE-driven run-status edge — no polling.
   *
   * Returns true iff the fetched page was actually APPLIED to the store —
   * false on error, abort, or when the apply was skipped because a run is
   * live (see `applyReconcile`). Callers use this to keep the queue-dirty
   * flag set when the reconcile didn't land, so a later terminal retries.
   *
   * Errors are logged, not surfaced — the next terminal (or a reload) retries.
   */
  async reconcileFromServer(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const page = await this.fetchLatestPage("tool error");
      if (page.kind === "aborted") return false;
      if (page.kind === "error") {
        console.warn("[chat-store] reconcileFromServer:", page.message);
        return false;
      }
      return this.applyReconcile(page.items, page.hasMore);
    } catch (err) {
      console.warn("[chat-store] reconcileFromServer failed:", err);
      return false;
    }
  }

  /**
   * Apply a fetched authoritative page to the live store — the apply half of
   * `reconcileFromServer`, split out so the live-run guard is unit-testable.
   *
   * Guard: if a run is live on this connection RIGHT NOW ("submitted" /
   * "streaming"), skip the apply entirely and return false. The reconcile
   * fetch resolves asynchronously — by the time it lands, the NEXT queued
   * turn may already be streaming, and its in-flight transient assistant row
   * is indistinguishable from a stale one; applying now would drop the live
   * turn's not-yet-persisted reply mid-stream (it would visibly vanish until
   * that turn's own terminal re-reconciles). Skipping is safe: the caller
   * keeps the queue-dirty flag set, so the streaming turn's own terminal
   * `decopilot.thread.status` event re-triggers a reconcile at a quiet
   * moment. The status check and the store update run in the same
   * synchronous block, so no chunk can interleave between them.
   */
  applyReconcile(items: UIMessage[], hasMore?: boolean): boolean {
    const statusKind = this.status.get().kind;
    if (statusKind === "submitted" || statusKind === "streaming") {
      return false;
    }
    this.messages.update((curr) => reconcileLatestPage(curr, items));
    if (hasMore !== undefined) {
      this.hasMoreOlder.set(hasMore);
    }
    return true;
  }

  /**
   * Fetch the next older page of messages. Triggered by the top-of-list
   * sentinel + IntersectionObserver in the chat UI.
   *
   * Uses `serverFetchedCount` as the offset cursor. With orderBy
   * created_at desc and append-only thread messages (server inserts only
   * at the head), offset pagination produces overlap on concurrent
   * inserts but never gaps — overlap is absorbed by mergeAndSort's
   * upsert-by-id.
   *
   * Guards: noop if no client, no more older pages, or another fetch is
   * already in flight (the sentinel can re-trigger rapidly on small pages).
   */
  async fetchOlderMessages(): Promise<void> {
    if (!this.client) return;
    if (!this.hasMoreOlder.get()) return;
    if (this.isFetchingOlder.get()) return;
    this.isFetchingOlder.set(true);
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREAD_MESSAGES_LIST",
        arguments: {
          thread_id: this.threadId,
          limit: this.pageSize,
          offset: this.serverFetchedCount,
          orderBy: [{ field: ["created_at"], direction: "desc" }],
        },
      });
      if (this.abort.signal.aborted) return;
      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(
            result,
            "COLLECTION_THREAD_MESSAGES_LIST failed",
          ),
        );
      }
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as {
        items?: UIMessage[];
        hasMore?: boolean;
      };
      const items = payload.items ?? [];
      this.messages.update((curr) => mergeAndSort(curr, items));
      this.serverFetchedCount += items.length;
      this.hasMoreOlder.set(payload.hasMore ?? false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[chat-store] fetchOlderMessages failed:", msg);
      toast.error(`Could not load older messages: ${msg}`);
    } finally {
      this.isFetchingOlder.set(false);
    }
  }

  // ── Internal: POST /messages ────────────────────────────────────────────

  private async post(
    message: UIMessage,
    opts: RequestOptions,
    signal?: AbortSignal,
    quiet = false,
  ): Promise<void> {
    const { system, ...rest } = opts;
    // Attach the system prompt only on a user turn. Tool-output / approval
    // continuations re-POST the assistant message; the server already has
    // the system context for the run.
    const systemMessage: UIMessage | null =
      system && message.role === "user"
        ? {
            id: crypto.randomUUID(),
            role: "system",
            parts: [{ type: "text", text: system }],
          }
        : null;
    const messages = systemMessage ? [systemMessage, message] : [message];
    const body = { messages, ...rest };
    const url = `/api/${encodeURIComponent(this.orgSlug)}/decopilot/threads/${encodeURIComponent(this.threadId)}/messages`;
    // G1: combine the caller's stop() abort signal with a generous timeout so
    // a stalled server never hangs the chat indefinitely. The POST is
    // idempotency-keyed (workflowID), so a timeout-then-retry is safe.
    const timeoutSignal = AbortSignal.timeout(POST_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (err) {
      // Surface timeout as a clear, user-actionable error message.
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new Error("request timed out — retry");
      }
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `POST /messages failed (${resp.status})`);
    }
    // A queued (quiet) POST must not touch the running turn's status display.
    if (!quiet && this.runStatusStage.get() !== null) {
      this.setRunStatusStage("received");
    }
  }

  // ── Internal: SSE loop ──────────────────────────────────────────────────

  /**
   * Persistent stream loop with reconnect/backoff. Terminal on HTTP error,
   * schema mismatch, or signal abort. Transient on TypeError / mid-byte
   * truncation / clean reader done — backoff and retry.
   */
  private async runSseLoop(): Promise<void> {
    const url = `/api/${encodeURIComponent(this.orgSlug)}/decopilot/threads/${encodeURIComponent(this.threadId)}/stream`;
    let attempt = 0;
    let firstConnect = true;

    while (!this.abort.signal.aborted) {
      if (!firstConnect) {
        // Drop the in-flight fold before the upcoming refetch so duplicate
        // deltas don't accumulate.
        this.forceCloseSubStream(true);
      }

      let cleanExit = false;
      try {
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (resp.status === 204 || !resp.body) return;
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          this.failTo(new Error(text || `GET /stream failed (${resp.status})`));
          return;
        }
        attempt = 0;
        if (!firstConnect) {
          // On reconnect, refresh the latest page so any messages persisted
          // while disconnected become visible. Merge is upsert-by-id + sort
          // by created_at; optimistic local rows survive (their id isn't on
          // the server yet).
          await this.refetchLatestPage();
        }
        firstConnect = false;
        cleanExit = await this.consumeStreamSse(resp.body);
        if (!cleanExit && this.status.get().kind === "error") {
          // Schema mismatch / parser failure routed through failTo — terminal.
          return;
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // Transient — fall through to backoff.
        void err;
      }

      if (this.abort.signal.aborted) return;
      // G2: use @decocms/shared/std exponential backoff with jitter (CLAUDE.md bans
      // hand-rolled backoff). Clean exits use the fast-path const; error
      // exits get jittered backoff so thundering-herd on server restarts is
      // spread out.
      const delay = cleanExit
        ? CLEAN_RECONNECT_DELAY_MS
        : exponentialBackoffWithJitter(
            MAX_DELAY_MS,
            BASE_DELAY_MS,
            attempt,
            2,
            0.5,
          );
      attempt++;
      if (delay > 0) {
        // G2: use @decocms/shared/std sleep (CLAUDE.md bans hand-rolled setTimeout
        // promises). sleep() resolves (not rejects) on abort by default, which
        // matches the previous "resolve on abort" semantics.
        await sleep(delay, { signal: this.abort.signal }).catch(() => {});
      }
    }
  }

  /** Parse the body as SSE frames. Returns true on clean EOF, false if a
   *  frame routed through `failTo()` (schema mismatch / parser error). */
  private async consumeStreamSse(
    body: ReadableStream<Uint8Array>,
  ): Promise<boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        await this.handleStreamFrame(frame);
        if (this.status.get().kind === "error") return false;
      }
    }
  }

  private async handleStreamFrame(frame: string): Promise<void> {
    const lines = frame.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");

    // The server no longer emits `event: snapshot` (initial state comes
    // from COLLECTION_THREAD_MESSAGES_LIST). Any non-"message" SSE event
    // received from a stale server is silently ignored.
    if (event !== "message") return;

    // Default: a UIMessageChunk JSON payload.
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (err) {
      this.failTo(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    await this.validateAndHandleChunk(payload);
  }

  private async validateAndHandleChunk(payload: unknown): Promise<void> {
    // `uiMessageChunkSchema` is an AI SDK LazySchema — call it to get the
    // underlying Schema and use its `validate` method. Behaviour matches the
    // prior `parseJsonEventStream` path: schema mismatch routes through
    // `failTo` (terminal); structural validation passes through to
    // `handleChunk`.
    try {
      const schema = uiMessageChunkSchema();
      const result = schema.validate
        ? await schema.validate(payload)
        : { success: true as const, value: payload as UIMessageChunk };
      if (!result.success) {
        this.failTo(
          result.error instanceof Error
            ? result.error
            : new Error(String(result.error)),
        );
        return;
      }
      this.handleChunk(result.value as UIMessageChunk);
    } catch (err) {
      this.failTo(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drainChunkBuffer(): void {
    const buffered = this.chunkBuffer ?? [];
    this.chunkBuffer = null;
    for (const chunk of buffered) this.handleChunk(chunk);
  }

  private setRunStatusStage(stage: RunStatusStage): void {
    this.runStatusStage.update((current) =>
      advanceRunStatusStage(current, stage),
    );
  }

  private clearRunStatusStage(): void {
    if (this.runStatusStage.get() !== null) {
      this.runStatusStage.set(null);
    }
  }

  private handleChunk(chunk: UIMessageChunk): void {
    if (this.chunkBuffer !== null) {
      this.chunkBuffer.push(chunk);
      return;
    }
    // A user prompt mirrored onto the run stream (see server
    // `user-message-stream.ts`). Intercept BEFORE the assistant fold — the AI
    // SDK reassembler hardcodes `role:"assistant"` — and upsert it by id so the
    // author's optimistic copy dedupes while other viewers get it live.
    if ((chunk as { type?: unknown }).type === "data-user-message") {
      const message = (chunk as { data?: UIMessage }).data;
      if (message) this.applyLocalMessage(message);
      return;
    }
    const isRunStatusControl = isRunStatusControlChunk(chunk);
    const runStatusStage = parseRunStatusStageChunk(chunk);
    if (this.waitingForNewRun) {
      if (isRunStatusControl) {
        if (this.acceptPreStartRunStatus && runStatusStage) {
          this.setRunStatusStage(runStatusStage);
          this.observer?.onData?.(
            chunk as Extract<UIMessageChunk, { type: `data-${string}` }>,
          );
        }
        return;
      }
      if (chunk.type !== "start") return;
      this.waitingForNewRun = false;
      this.acceptPreStartRunStatus = true;
    }
    if (isRunStatusControl) {
      if (runStatusStage) {
        this.setRunStatusStage(runStatusStage);
        this.observer?.onData?.(
          chunk as Extract<UIMessageChunk, { type: `data-${string}` }>,
        );
      }
      return;
    }
    if (
      chunk.type !== "start" &&
      chunk.type !== "finish" &&
      !chunk.type.startsWith("data-") &&
      chunk.type !== "start-step"
    ) {
      this.clearRunStatusStage();
    }
    if (chunk.type.startsWith("data-")) {
      this.observer?.onData?.(
        chunk as Extract<UIMessageChunk, { type: `data-${string}` }>,
      );
    }
    if (chunk.type === "tool-input-available") {
      const c = chunk as {
        type: "tool-input-available";
        toolCallId: string;
        toolName: string;
        input: unknown;
      };
      this.observer?.onToolCall?.({
        toolCall: {
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        },
      });
    }
    if (chunk.type === "start") {
      this.freshRunSubstream = true;
    }
    const sub = this.ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      const f = chunk as { type: "finish"; finishReason?: string };
      this.pendingFinishReason = f.finishReason;
      this.clearRunStatusStage();
      // Null subController BEFORE close() so a synchronous reconnect
      // (which fires before the async fold loop resumes) can't mark a
      // cleanly-completed run as discardable.
      this.subController = null;
      sub.close();
    }
  }

  private forceCloseSubStream(discard = false): void {
    const ctrl = this.subController;
    if (!ctrl) return;
    this.discardOnClose = discard;
    this.subController = null;
    try {
      ctrl.close();
    } catch {
      // already closed
    }
  }

  private ensureSubStream(): ReadableStreamDefaultController<UIMessageChunk> {
    if (this.subController) return this.subController;
    this.pendingFinishReason = undefined;
    let controllerOut: ReadableStreamDefaultController<UIMessageChunk>;
    const sub = new ReadableStream<UIMessageChunk>({
      start(c) {
        controllerOut = c;
      },
    });
    // biome-ignore lint/style/noNonNullAssertion: set synchronously in start()
    this.subController = controllerOut!;
    void this.foldSubStream(sub);
    // biome-ignore lint/style/noNonNullAssertion: set synchronously above
    return controllerOut!;
  }

  /**
   * Fold the sub-stream into the unified `messages` store. The in-progress
   * assistant message lives as the last item in `messages` — chunks update
   * it in place rather than living in a separate `streaming` slot.
   *
   * Seed: if `messages.at(-1)` is an assistant whose id matches the
   * upcoming first chunk, the AI SDK's reader will resolve patches against
   * its parts (tool outputs, approvals). Otherwise the reader emits a
   * fresh assistant message and we append.
   */
  private async foldSubStream(
    sub: ReadableStream<UIMessageChunk>,
  ): Promise<void> {
    const prev = this.messages.get();
    const lastMsg = prev.at(-1);
    // A tool-approval CONTINUATION run streams the approved/denied tool's
    // output (+ the assistant's follow-up) under a FRESH harness message id,
    // while the pending tool part still lives on the trailing assistant
    // "proposal". Seed the reassembler with that proposal so the `tool-output`
    // chunk reconciles (no "No tool invocation found" throw) and PIN the folded
    // id back to the proposal id so the run merges onto the proposal instead of
    // creating a duplicate — mirroring the projector's `continuationMessageId`.
    // We clone the seed because `readUIMessageStream` mutates `message` in place.
    const isApprovalContinuation =
      this.freshRunSubstream &&
      lastMsg?.role === "assistant" &&
      (lastMsg.parts ?? []).some(
        (p) =>
          "state" in p &&
          (p.state === "approval-requested" ||
            p.state === "approval-responded"),
      );
    const seed = isApprovalContinuation
      ? (structuredClone(lastMsg) as UIMessage)
      : !this.freshRunSubstream &&
          prev.length > 0 &&
          lastMsg?.role === "assistant"
        ? lastMsg
        : undefined;
    const pinnedMessageId = isApprovalContinuation ? lastMsg?.id : undefined;
    this.freshRunSubstream = false;
    const iter = readUIMessageStream({
      message: seed,
      // Guard the tool-invocation invariant: after abnormal termination
      // (ghost-run force-fail, subject purge, retention gap) a tool's output
      // can arrive without its input part, which otherwise throws
      // "No tool invocation found for tool call ID …" and bricks the chat.
      stream: guardToolInvariant(sub, seed),
      onError: (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.failTo(err);
      },
    });

    // Coalesce store updates to at most one per animation frame. A long
    // tool-args burst (e.g. claude-sonnet emitting hundreds of
    // `tool-input-delta` chunks in a few seconds) used to call
    // `messages.update` per chunk and trigger one React re-render each —
    // the resulting forced-reflow storm froze the chat. `readUIMessageStream`
    // yields cumulative messages, so dropping intermediate frames is safe:
    // each commit always carries the latest state.
    let last: UIMessage | null = null;
    let pending: UIMessage | null = null;
    let rafHandle: number | null = null;
    const commit = () => {
      rafHandle = null;
      if (!pending) return;
      // Pin a continuation's folded id back to the proposal id so it upserts
      // onto the proposal row rather than appending a duplicate (the fresh
      // harness `start.messageId` would otherwise become a second message).
      const msg =
        pinnedMessageId && pending.id !== pinnedMessageId
          ? ({ ...pending, id: pinnedMessageId } as UIMessage)
          : pending;
      pending = null;
      this.messages.update((curr) =>
        mergeAndSort(
          dropRedundantStubs(upsertById(curr, stampInflightOrder(curr, msg))),
          [],
        ),
      );
    };
    for await (const msg of iter) {
      last = msg;
      pending = msg;
      if (rafHandle === null) {
        rafHandle = scheduleFrame(commit);
      }
      if (this.status.get().kind !== "streaming") {
        this.status.set({ kind: "streaming" });
      }
    }
    if (rafHandle !== null) {
      cancelFrame(rafHandle);
      rafHandle = null;
    }
    if (pending) commit();

    const finishReason = this.pendingFinishReason;
    const discard = this.discardOnClose;
    this.subController = null;
    this.pendingFinishReason = undefined;
    this.discardOnClose = false;

    if (!discard) {
      this.finishReason.set(finishReason ?? null);
      this.status.set({ kind: "ready" });
    }
    if (last && !discard) {
      // Anchor the finished assistant with a top-level `created_at`. A streamed
      // message that never received one reads as +Infinity in `mergeAndSort`;
      // on the NEXT submit the role tiebreak (user before assistant) then sorts
      // the new user row ahead of this reply — the prior turn renders empty and
      // its answer lands under the new turn. Prefer the run-start metadata
      // timestamp when present, else stamp finish time. Mirrors the cancel-path
      // anchor; a later persisted refetch (which carries the DB `created_at`)
      // overwrites this via upsert. No-op once a top-level `created_at` exists.
      // A pinned continuation commits under the proposal id, not `last.id`.
      const anchorId = pinnedMessageId ?? last.id;
      this.messages.update((msgs) => {
        const i = msgs.findIndex((m) => m.id === anchorId);
        if (i === -1) return msgs;
        const row = msgs[i] as UIMessage & { created_at?: string };
        if (row.created_at != null) return msgs;
        const metaTs = (
          row.metadata as { created_at?: string | number | Date } | undefined
        )?.created_at;
        const created_at =
          metaTs != null
            ? new Date(metaTs).toISOString()
            : new Date().toISOString();
        const next = [...msgs];
        next[i] = { ...row, created_at } as UIMessage;
        return next;
      });
      this.observer?.onFinish?.(last, this.messages.get(), finishReason);

      // A turn auto-resumed after a backgrounded tool (image / subtask) delivers
      // that tool's result as a SEPARATE assistant message, appended directly to
      // the DB by the background workflow — it never rides this live stream. Pull
      // the latest page now so the delivered result shows without a manual
      // refresh. Runs after the reaction folded, so it can't clobber in-flight
      // streaming; the merge is upsert-by-id.
      const meta = last.metadata as
        | { resumedFromBackground?: boolean }
        | undefined;
      if (meta?.resumedFromBackground) {
        void this.refetchLatestPage();
      }
    }
  }

  // ── Internal: error helper ──────────────────────────────────────────────

  private failTo(err: Error): void {
    if (this.abort.signal.aborted) return;
    this.clearRunStatusStage();
    this.status.set({ kind: "error", error: err });
    this.observer?.onError?.(err);
  }
}

/**
 * Keep the prior row's authoritative `created_at` when its replacement lacks
 * one. A `deliverPolicy: "all"` replay on reconnect re-delivers an
 * already-persisted run as timestamp-less streamed UIMessages; upserting one
 * over its DB-seeded row would otherwise strip the `created_at`, so
 * `readTimestamp` returns +Infinity and the message jumps to the end of the
 * sort — it renders under the NEXT turn's user message and leaves its own slot
 * empty ("No response was generated"). Only fills a missing timestamp; a
 * genuine persisted update (incoming has `created_at`) overwrites as before.
 */
/**
 * Carry each tool call part's persisted `created_at` forward across a merge.
 * The durable (DB-loaded) copy of an in-flight message has a per-part
 * `created_at` (stamped by `foldParts`); the streamed/replayed copy that
 * upserts over it does not. Without this, a late-attaching or reconnecting
 * client loses the fire time of a still-running call (e.g. the `bash` `sleep`
 * countdown anchor) and restarts the timer. Matched by `toolCallId`; only fills
 * a missing timestamp, so a genuine durable update still wins.
 */
function preservePartCreatedAt(
  prev: UIMessage,
  next: UIMessage,
): UIMessage["parts"] {
  const prevByToolCall = new Map<string, unknown>();
  for (const p of prev.parts) {
    if (
      p &&
      typeof p === "object" &&
      "toolCallId" in p &&
      "created_at" in p &&
      typeof (p as { toolCallId?: unknown }).toolCallId === "string"
    ) {
      prevByToolCall.set(
        (p as { toolCallId: string }).toolCallId,
        (p as { created_at: unknown }).created_at,
      );
    }
  }
  if (prevByToolCall.size === 0) return next.parts;
  return next.parts.map((p) => {
    if (
      p &&
      typeof p === "object" &&
      "toolCallId" in p &&
      !("created_at" in p) &&
      typeof (p as { toolCallId?: unknown }).toolCallId === "string"
    ) {
      const carried = prevByToolCall.get(
        (p as { toolCallId: string }).toolCallId,
      );
      if (carried != null) return { ...p, created_at: carried };
    }
    return p;
  });
}

function preserveCreatedAt(
  prev: UIMessage | undefined,
  next: UIMessage,
): UIMessage {
  if (!prev) return next;
  const prevTs = (prev as { created_at?: unknown }).created_at;
  const nextTs = (next as { created_at?: unknown }).created_at;
  const parts = preservePartCreatedAt(prev, next);
  let result = parts === next.parts ? next : ({ ...next, parts } as UIMessage);
  if (nextTs == null && prevTs != null) {
    result = { ...result, created_at: prevTs } as UIMessage;
  }
  return result;
}

export function upsertById(list: UIMessage[], msg: UIMessage): UIMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = [...list];
  next[idx] = preserveCreatedAt(next[idx], msg);
  return next;
}

const ASYNC_STUB_ID_PREFIX = "msg_async_stub_";

/**
 * Drop `msg_async_stub_<toolCallId>` rows when another assistant message
 * already carries the matching `tool-web_search` part.
 *
 * The stub is inserted by the server at `markPolling` time (see
 * `apps/api/src/storage/async-research-jobs.ts`) so a browser refresh
 * during the long polling window has something to seed
 * `readUIMessageStream` against — without it, the SDK throws
 * "No tool invocation found" when the eventual `tool-output-available`
 * chunk arrives.
 *
 * The collateral was that on a proxy-driven SSE reattach (customer's
 * infra cuts every ~2 min), the client ends up with TWO assistant
 * messages for the same turn: the persisted stub (refetched from the
 * DB after the cut) and the in-memory AI-SDK message built from the
 * first connection's chunks. The fold writes to the in-memory one,
 * the stub stays frozen on its `input-available` state, and the UI
 * shows what looks like a stuck loading skeleton next to the actual
 * (correct) content. Refreshing the page hides this because
 * `markCompleted` has already deleted the stub by then.
 *
 * Once the live assistant row carries the same `tool-web_search`
 * part, the stub is redundant. Filtering it out at the
 * write-to-`messages` boundary keeps it from ever rendering as a
 * phantom turn.
 */
export function dropRedundantStubs(messages: UIMessage[]): UIMessage[] {
  let hasStub = false;
  for (const m of messages) {
    if (m.id.startsWith(ASYNC_STUB_ID_PREFIX)) {
      hasStub = true;
      break;
    }
  }
  if (!hasStub) return messages;

  // Tool-call ids covered by NON-stub assistant messages. A stub whose
  // suffix matches one of these is redundant.
  const covered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.id.startsWith(ASYNC_STUB_ID_PREFIX)) continue;
    for (const p of m.parts) {
      if (
        p &&
        typeof p === "object" &&
        "type" in p &&
        (p as { type: string }).type === "tool-web_search" &&
        "toolCallId" in p
      ) {
        covered.add((p as { toolCallId: string }).toolCallId);
      }
    }
  }
  if (covered.size === 0) return messages;

  return messages.filter((m) => {
    if (!m.id.startsWith(ASYNC_STUB_ID_PREFIX)) return true;
    // Match by the stub's own tool-web_search part id — robust to any id shape.
    // (The id suffix is only a fallback for a malformed stub with no part.)
    const toolCallId =
      webSearchToolCallId(m) ?? m.id.slice(ASYNC_STUB_ID_PREFIX.length);
    return !covered.has(toolCallId);
  });
}

/** First `tool-web_search` part's `toolCallId` on a message, if any. */
function webSearchToolCallId(m: UIMessage): string | undefined {
  for (const p of m.parts) {
    if (
      p &&
      typeof p === "object" &&
      "type" in p &&
      (p as { type: string }).type === "tool-web_search" &&
      "toolCallId" in p &&
      typeof (p as { toolCallId?: unknown }).toolCallId === "string"
    ) {
      return (p as { toolCallId: string }).toolCallId;
    }
  }
  return undefined;
}

/**
 * Merge `incoming` rows into `prev` (upsert by id), then sort the result
 * ascending by `(created_at, id)`. The id tiebreaker mirrors
 * `storage.threads.listMessages`'s `ORDER BY created_at, id` for stability
 * across batched inserts.
 *
 * Messages without a `created_at` (an in-flight optimistic message before
 * the server has persisted it) sort to the end (treated as +Infinity).
 * They are the newest by construction; once the persisted row arrives,
 * the upsert replaces them and the sort resettles.
 */
export function mergeAndSort(
  prev: UIMessage[],
  incoming: UIMessage[],
): UIMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m] as const));
  for (const m of incoming)
    byId.set(m.id, preserveCreatedAt(byId.get(m.id), m));
  const merged = [...byId.values()];
  merged.sort((a, b) => {
    const ta = readTimestamp(a);
    const tb = readTimestamp(b);
    if (ta !== tb) return ta - tb;
    // Mirrors `listMessages` role tiebreak: user before assistant on equal
    // timestamps (in-flight rows with no top-level `created_at` yet).
    const roleRank = (m: UIMessage) =>
      m.role === "user" ? 0 : m.role === "assistant" ? 1 : 2;
    const ra = roleRank(a);
    const rb = roleRank(b);
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return dropRedundantStubs(merged);
}

/**
 * Persisted messages from COLLECTION_THREAD_MESSAGES_LIST carry the DB row's
 * `created_at` at the top level. AI-SDK UIMessages don't declare that field,
 * so we read it via a defensive cast. Some assistant messages additionally
 * stamp a `metadata.created_at` at run-start. Once the row is persisted the
 * top-level `created_at` is authoritative — using metadata then would sort
 * the assistant too early. In-flight assistants (no top-level yet) may fall
 * back to metadata so a still-streaming turn-1 reply doesn't leap behind a
 * newly-submitted turn-2 user row during live mergeAndSort.
 */
/**
 * Reconcile the live message store against an authoritative latest page from
 * the server, dropping stale in-flight assistant rows the live substream-fold
 * left behind.
 *
 * Why this exists: when a queued turn dequeues, its chunks fold into the
 * already-open stream under a TRANSIENT client-generated id (the relay doesn't
 * propagate the server's persisted message id in the `start` chunk). That
 * transient assistant can clobber the prior turn's reply, and because its id
 * never matches the persisted id a plain `mergeAndSort` would DUPLICATE it
 * rather than replace it. On each run terminal we refetch the authoritative
 * latest page and call this: any assistant row inside the fetched window (a
 * timestamp-less transient, or one newer than the oldest fetched row) whose id
 * is absent from the fetch is stale and dropped; the fetched rows then merge in
 * as DB truth.
 *
 * Only assistant rows are dropped — user rows are either persisted (in the
 * fetch) or optimistic for a not-yet-terminal turn and must survive. Rows at or
 * below the fetched window's oldest timestamp (earlier pages / history) are
 * untouched. Pure + total.
 */
export function reconcileLatestPage(
  current: UIMessage[],
  fetched: UIMessage[],
): UIMessage[] {
  if (fetched.length === 0) return current;
  const fetchedIds = new Set(fetched.map((m) => m.id));
  let cutoff = Number.POSITIVE_INFINITY;
  for (const m of fetched) {
    const t = readTimestamp(m);
    if (t < cutoff) cutoff = t;
  }
  const kept = current.filter((m) => {
    if (m.role !== "assistant") return true;
    if (fetchedIds.has(m.id)) return true;
    // Assistant absent from the authoritative fetch: keep only if it's older
    // history (finite timestamp at or below the window). A transient (+Infinity)
    // or a row newer than the window's floor but missing from the page is stale.
    const t = readTimestamp(m);
    return Number.isFinite(t) && t <= cutoff;
  });
  return mergeAndSort(kept, fetched);
}

/**
 * Give the in-flight streamed reply a client-clock top-level `created_at` so it
 * sorts directly after the user turn it answers.
 *
 * The reply arrives carrying only a SERVER-clock `metadata.created_at` (stamped
 * at run-start in run-stream.ts), while the optimistic user row is stamped with
 * the CLIENT clock (`applyLocally`). Comparing the two in `mergeAndSort` mixes
 * clock domains: if the client is ahead of the server by more than the POST
 * latency, the reply's server timestamp predates the user's client timestamp
 * and the reply sorts AHEAD of its own user turn — order-based `useMessagePairs`
 * then pairs the reply with the previous turn and the current turn renders empty
 * ("No response was generated"), until a refetch brings all-server timestamps.
 *
 * Stamp a client-clock timestamp strictly after everything currently in the
 * store (same trick as `applyLocally`), keeping both rows in one clock domain.
 * Only on the row's first appearance — later commits carry the stamp forward via
 * `preserveCreatedAt`; a genuine DB refetch (incoming has `created_at`)
 * overwrites it with the authoritative server value.
 */
function stampInflightOrder(curr: UIMessage[], m: UIMessage): UIMessage {
  if ((m as { created_at?: unknown }).created_at != null) return m;
  const existing = curr.find((x) => x.id === m.id) as
    | (UIMessage & { created_at?: unknown })
    | undefined;
  if (existing?.created_at != null) return m;
  let maxMs = 0;
  for (const x of curr) {
    const t = readTimestamp(x);
    if (Number.isFinite(t) && t > maxMs) maxMs = t;
  }
  if (maxMs === 0) return m;
  return { ...m, created_at: new Date(maxMs + 1).toISOString() } as UIMessage;
}

function readTimestamp(m: UIMessage): number {
  const withTs = m as unknown as { created_at?: string | number | Date };
  if (withTs.created_at != null) {
    return new Date(withTs.created_at).getTime();
  }
  const meta = m.metadata as
    | { created_at?: string | number | Date }
    | undefined;
  if (meta?.created_at != null) {
    return new Date(meta.created_at).getTime();
  }
  return Number.POSITIVE_INFINITY;
}

// ─── Module-scoped slot ──────────────────────────────────────────────────────

let current: ThreadConnection | null = null;

/** Idempotent: same key → same instance. Different key → dispose + reopen. */
export function getOrOpenStream(
  orgSlug: string,
  threadId: string,
  opts: ThreadConnectionOptions = {},
): ThreadConnection {
  const key = `${orgSlug}::${threadId}`;
  if (current?.key === key) return current;
  current?.dispose();
  current = new ThreadConnection(orgSlug, threadId, opts);
  // DEBUG (temporary): expose the live store for inspecting in-memory order.
  if (typeof window !== "undefined")
    (window as unknown as { __conn?: ThreadConnection }).__conn = current;
  return current;
}

/** Test-only: clear the active connection. Aborts in-flight fetch. */
export function __resetRegistry(): void {
  current?.dispose();
  current = null;
}
