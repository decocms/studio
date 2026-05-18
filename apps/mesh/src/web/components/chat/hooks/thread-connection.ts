/**
 * ThreadConnection — self-contained per-thread data + transport.
 *
 * Owns:
 *   • one persistent SSE GET /stream loop (reconnect+backoff)
 *   • one-shot POST /messages for sends + continuations
 *   • a single `messages` Store that's the only source of truth
 *   • `status` and `finishReason` Stores read by the React layer
 *
 * Lifecycle:
 *   constructor → bootstrap() fetches the server snapshot via
 *   COLLECTION_THREAD_MESSAGES_LIST, sets messages, then opens the SSE.
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
 * Server-snapshot reconciliation:
 *   refresh() re-fetches the snapshot and replaces messages. Server is
 *   authoritative — except while a submit is in flight (status="submitted"),
 *   in which case refresh() is a no-op. The next event after the POST
 *   settles will refresh normally.
 */

import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { ToolApprovalLevel } from "@/web/hooks/use-preferences";
import type { SimpleModeTier } from "@/tools/organization/schema";
import type { ChatMode } from "../types";

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

/**
 * Per-update emitter (does not batch across SSE chunks). React subscribes via
 * useSyncExternalStore.
 */
export class Store<T> {
  private subs = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set = (next: T): void => {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.subs.forEach((s) => s());
  };
  update = (fn: (prev: T) => T): void => {
    this.set(fn(this.value));
  };
  subscribe = (s: () => void): (() => void) => {
    this.subs.add(s);
    return () => {
      this.subs.delete(s);
    };
  };
}

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
    return [...prev, action.message];
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

function findTargetPartIndex(
  parts: UIMessage["parts"],
  action: Exclude<SubmitAction, { kind: "message" }>,
): number {
  if (action.kind === "toolOutput") {
    return parts.findIndex(
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous AI SDK part union
      (p) => (p as any)?.toolCallId === action.toolCallId,
    );
  }
  return parts.findIndex((p) => {
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous AI SDK part union
    const x = p as any;
    return (
      x?.state === "approval-requested" && x?.approval?.id === action.approvalId
    );
  });
}

function patchPart(
  part: UIMessage["parts"][number],
  action: Exclude<SubmitAction, { kind: "message" }>,
): UIMessage["parts"][number] | null {
  if (action.kind === "toolOutput") {
    return {
      ...part,
      state: action.state ?? "output-available",
      output: action.output,
      errorText: action.errorText,
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous AI SDK part union
    } as any;
  }
  return {
    ...part,
    state: "approval-responded",
    approval: {
      id: action.approvalId,
      approved: action.approved,
      ...(action.reason ? { reason: action.reason } : {}),
    },
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous AI SDK part union
  } as any;
}

function describe(action: SubmitAction): string {
  if (action.kind === "message") return `message id=${action.message.id}`;
  if (action.kind === "toolOutput")
    return `toolOutput toolCallId=${action.toolCallId}`;
  return `approval approvalId=${action.approvalId}`;
}

interface JsonRpcResponse {
  result?: { structuredContent?: { items?: UIMessage[] } };
  error?: { message?: string };
}

/** Parse a streamable-HTTP MCP response when the server picked
 *  `text/event-stream` over `application/json` content negotiation. The
 *  response body is one or more `data: <jsonrpc-message>` SSE events; for a
 *  single `tools/call` request we expect exactly one matching response
 *  message. */
async function parseSseSingleResponse(
  resp: Response,
): Promise<JsonRpcResponse> {
  const text = await resp.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    } catch {
      // ignore — next line might be the real response
    }
  }
  throw new Error("snapshot rpc: no response in stream");
}

// ─── ThreadConnection ────────────────────────────────────────────────────────

class ThreadConnection {
  readonly key: string;

  /** Single source of truth. Server snapshot on load, mutated locally on
   *  submit, mutated chunk-by-chunk during SSE streaming. */
  readonly messages = new Store<UIMessage[]>([]);
  readonly status = new Store<ConnStatus>({ kind: "loading" });
  readonly finishReason = new Store<string | null>(null);

  observer: ThreadObserver | null = null;

  /** Test-only escape hatch. Don't call from production. */
  readonly abort = new AbortController();

  // Demuxer state for the persistent SSE.
  private subController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  private pendingFinishReason: string | undefined = undefined;
  private discardOnClose = false;
  private inflightPost: AbortController | null = null;

  constructor(
    readonly orgSlug: string,
    readonly threadId: string,
  ) {
    this.key = `${orgSlug}::${threadId}`;
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
    this.messages.set(next);

    // A new user turn always POSTs. For approval / toolOutput actions, only
    // POST once the assistant turn has no remaining client-side resolutions
    // (other pending approvals or unresolved local tool inputs). The two
    // AI SDK predicates together cover both shapes.
    const shouldPost =
      action.kind === "message" ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: next }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages: next });

    if (!shouldPost) return;

    this.status.set({ kind: "submitted" });

    const last = next.at(-1);
    if (!last) {
      // Can't happen — applyLocally returned non-null so the list has ≥1 item.
      this.status.set({ kind: "ready" });
      return;
    }

    const abort = new AbortController();
    this.inflightPost = abort;
    try {
      await this.post(last, opts, abort.signal);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.failTo(e);
    } finally {
      if (this.inflightPost === abort) this.inflightPost = null;
    }
  }

  stop(): void {
    this.inflightPost?.abort();
    const s = this.status.get();
    if (s.kind === "submitted" || s.kind === "streaming") {
      this.status.set({ kind: "ready" });
    }
  }

  clearError(): void {
    const s = this.status.get();
    if (s.kind === "error") this.status.set({ kind: "ready" });
  }

  /**
   * Re-fetch the server snapshot and replace `messages`. Skipped while a
   * submit POST is in flight — the local patch would be transiently
   * overwritten by the not-yet-ingested server state. The next event after
   * the POST settles will refresh us.
   *
   * Called by ThreadEventsBridge on thread status / finish notifications.
   */
  async refresh(): Promise<void> {
    if (this.status.get().kind === "submitted") return;
    try {
      const snapshot = await this.fetchSnapshot();
      this.messages.set(snapshot);
    } catch (err) {
      // Soft-fail: a refresh failure shouldn't poison the conn. The next
      // event will retry. Surface to console for visibility.
      console.error("[ThreadConnection] refresh failed", err);
    }
  }

  // ── Internal: bootstrap ─────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    try {
      const snapshot = await this.fetchSnapshot();
      this.messages.set(snapshot);
      this.status.set({ kind: "ready" });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.failTo(e);
    }
    // Start the SSE loop regardless of snapshot result — the user can still
    // send and the run loop will reconnect on its own backoff schedule.
    void this.runSseLoop();
  }

  private async fetchSnapshot(): Promise<UIMessage[]> {
    const url = `/api/${encodeURIComponent(this.orgSlug)}/mcp/self`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        // MCP HTTP transport requires both — server returns 406 otherwise.
        accept: "application/json, text/event-stream",
      },
      signal: this.abort.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "COLLECTION_THREAD_MESSAGES_LIST",
          arguments: { thread_id: this.threadId, limit: 100 },
        },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `snapshot fetch failed (${resp.status})`);
    }
    // Server may stream as text/event-stream even though we requested a
    // tools/call. Parse SSE if applicable; otherwise treat as JSON.
    const contentType = resp.headers.get("content-type") ?? "";
    const body = contentType.includes("text/event-stream")
      ? await parseSseSingleResponse(resp)
      : ((await resp.json()) as JsonRpcResponse);
    if (body.error) {
      throw new Error(body.error.message ?? "snapshot rpc error");
    }
    return body.result?.structuredContent?.items ?? [];
  }

  // ── Internal: POST /messages ────────────────────────────────────────────

  private async post(
    message: UIMessage,
    opts: RequestOptions,
    signal?: AbortSignal,
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
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `POST /messages failed (${resp.status})`);
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
        // Drop the in-flight fold before the upcoming replay so duplicate
        // deltas don't accumulate.
        this.forceCloseSubStream(true);
      }
      firstConnect = false;

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
        const parsed = parseJsonEventStream({
          stream: resp.body,
          schema: uiMessageChunkSchema,
        });
        const reader = parsed.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            cleanExit = true;
            break;
          }
          if (!value.success) {
            this.failTo(value.error);
            return;
          }
          this.handleChunk(value.value as UIMessageChunk);
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // Transient — fall through to backoff.
        void err;
      }

      if (this.abort.signal.aborted) return;
      const delay = cleanExit
        ? 0
        : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      attempt++;
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }

  private handleChunk(chunk: UIMessageChunk): void {
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
    const sub = this.ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      const f = chunk as { type: "finish"; finishReason?: string };
      this.pendingFinishReason = f.finishReason;
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
    const seed =
      prev.length > 0 && prev.at(-1)?.role === "assistant"
        ? prev.at(-1)
        : undefined;
    const iter = readUIMessageStream({
      message: seed,
      stream: sub,
      onError: (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.failTo(err);
      },
    });

    let last: UIMessage | null = null;
    for await (const msg of iter) {
      last = msg;
      // Replace-by-id in place — the AI SDK reader emits the cumulative
      // message each chunk; we mirror that into `messages`.
      this.messages.update((curr) => upsertById(curr, msg));
      if (this.status.get().kind !== "streaming") {
        this.status.set({ kind: "streaming" });
      }
    }

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
      this.observer?.onFinish?.(last, this.messages.get(), finishReason);
    }
  }

  // ── Internal: error helper ──────────────────────────────────────────────

  private failTo(err: Error): void {
    if (this.abort.signal.aborted) return;
    this.status.set({ kind: "error", error: err });
    this.observer?.onError?.(err);
  }
}

function upsertById(list: UIMessage[], msg: UIMessage): UIMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = [...list];
  next[idx] = msg;
  return next;
}

// ─── Module-scoped slot ──────────────────────────────────────────────────────

let current: ThreadConnection | null = null;

/** Idempotent: same key → same instance. Different key → dispose + reopen. */
export function getOrOpenStream(
  orgSlug: string,
  threadId: string,
): ThreadConnection {
  const key = `${orgSlug}::${threadId}`;
  if (current?.key === key) return current;
  current?.dispose();
  current = new ThreadConnection(orgSlug, threadId);
  return current;
}

/** ThreadEventsBridge handle: look up the active conn by thread id without
 *  forcing a new construction. Returns null if no conn matches. */
export function getActiveConn(
  orgSlug: string,
  threadId: string,
): ThreadConnection | null {
  const key = `${orgSlug}::${threadId}`;
  return current?.key === key ? current : null;
}

/** Test-only: clear the active connection. Aborts in-flight fetch. */
export function __resetRegistry(): void {
  current?.dispose();
  current = null;
}
