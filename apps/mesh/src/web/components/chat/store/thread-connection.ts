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
 *   constructor → bootstrap() opens the SSE. The server emits an
 *   `event: snapshot` SSE frame as the FIRST frame on every connect; that
 *   frame seeds `messages`. Subsequent frames are UIMessageChunk events
 *   that fold into the in-progress assistant message.
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
 *   On every SSE reconnect the server re-emits `event: snapshot`, which
 *   replaces `messages` — except while a submit is in flight
 *   (status="submitted"), in which case the snapshot is dropped to avoid
 *   transiently overwriting the local optimistic patch.
 */

import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolApprovalLevel } from "@/web/hooks/use-preferences";
import type { SimpleModeTier } from "@/tools/organization/schema";
import { Store } from "./store-primitive";
import type { ChatMode } from "../types";

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

// ─── ThreadConnection ────────────────────────────────────────────────────────

export interface ThreadConnectionOptions {
  client?: MCPClient | null;
}

export class ThreadConnection {
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
  /**
   * After a manual stop(), drop chunks until the next `start` chunk so late
   * text-deltas / finish events from the cancelled run don't open a fresh
   * substream and land on a new assistant message after any user turn the
   * user has queued in the meantime.
   */
  private waitingForNewRun = false;
  // Set here; first real read added in the loadInitialPage path of a later commit.
  // @ts-expect-error TS6133 — intentionally unused until T5 plumbs loadInitialPage
  private _client: MCPClient | null;

  constructor(
    readonly orgSlug: string,
    readonly threadId: string,
    opts: ThreadConnectionOptions = {},
  ) {
    this.key = `${orgSlug}::${threadId}`;
    this._client = opts.client ?? null;
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
    // Freeze the in-flight assistant message at its current state and gate
    // every subsequent chunk on a fresh `start` boundary. Without this, the
    // cancel's racing tail chunks (or a server-side replay across an SSE
    // reconnect) would create a new assistant message that lands after any
    // user turn the user queues between Stop and the next run.
    if (this.subController) {
      this.forceCloseSubStream(true);
    }
    this.waitingForNewRun = true;
  }

  clearError(): void {
    const s = this.status.get();
    if (s.kind === "error") this.status.set({ kind: "ready" });
  }

  // ── Internal: bootstrap ─────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    await this.runSseLoop();
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
      const delay = cleanExit
        ? CLEAN_RECONNECT_DELAY_MS
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

    if (event === "snapshot") {
      // Drop the snapshot if a local submit is in flight — the optimistic
      // patch in `messages` is fresher than the server-side persisted state.
      if (this.status.get().kind === "submitted") return;
      try {
        const parsed = JSON.parse(data) as { messages: UIMessage[] };
        this.messages.set(parsed.messages);
        if (this.status.get().kind === "loading") {
          this.status.set({ kind: "ready" });
        }
      } catch {
        // Malformed snapshot frame — ignore. Subsequent frames still process.
      }
      return;
    }

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

  private handleChunk(chunk: UIMessageChunk): void {
    if (this.waitingForNewRun) {
      if (chunk.type !== "start") return;
      this.waitingForNewRun = false;
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

/**
 * Merge `incoming` rows into `prev` (upsert by id), then sort the result
 * ascending by `(metadata.created_at, id)`. The id tiebreaker mirrors
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
  for (const m of incoming) byId.set(m.id, m);
  const merged = [...byId.values()];
  merged.sort((a, b) => {
    const ta = readTimestamp(a);
    const tb = readTimestamp(b);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged;
}

function readTimestamp(m: UIMessage): number {
  const md = m.metadata as { created_at?: string | number | Date } | undefined;
  if (md?.created_at == null) return Number.POSITIVE_INFINITY;
  return new Date(md.created_at).getTime();
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
  return current;
}

/** Test-only: clear the active connection. Aborts in-flight fetch. */
export function __resetRegistry(): void {
  current?.dispose();
  current = null;
}
