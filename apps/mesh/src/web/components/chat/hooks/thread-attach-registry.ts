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

/**
 * The per-call request payload the wire expects alongside `messages`.
 * Required at every call site so the auto-send continuation POST carries
 * the same context as the originating user send — no implicit
 * module-scoped reads, no silently-empty metadata.
 */
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

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Trigger an automatic continuation when the last assistant message has
 * either tool outputs ready to feed back, or all approvals answered. Pure
 * function of messages; no per-thread policy variation today.
 */
const shouldAutoSend = (messages: UIMessage[]): boolean =>
  lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
  lastAssistantMessageIsCompleteWithApprovalResponses({ messages });

export type ChatStreamStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * Hand-rolled emitter so React subscribers re-render on each update without
 * batching across the persistent stream's chunks.
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

const LOCAL_MARKER = Symbol("local-user-message");
type Tagged<T> = T & { [LOCAL_MARKER]?: true };

/**
 * Compose server snapshot + local extras (optimistic user messages,
 * folded assistant messages, in-place patches). Local wins on id collision
 * because local is always the more-recent version (we patch eagerly on
 * tool output / approval response and would otherwise show stale server
 * data and feed it back into the continuation POST body).
 */
function mergeWithServer<UI_MESSAGE extends UIMessage>(
  server: UI_MESSAGE[],
  local: Tagged<UI_MESSAGE>[],
): UI_MESSAGE[] {
  if (local.length === 0) return server.slice();
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverIds = new Set(server.map((m) => m.id));
  const merged = server.map((m) => localById.get(m.id) ?? m);
  for (const m of local) {
    if (!serverIds.has(m.id)) merged.push(m);
  }
  return merged;
}

/** Per-render context the hook keeps fresh on each render. */
export interface ThreadContext {
  initialMessages: UIMessage[];
}

/** The single observer slot — populated by the active hook mount. */
export interface ThreadObserver {
  onData?: (chunk: Extract<UIMessageChunk, { type: `data-${string}` }>) => void;
  onToolCall?: (event: {
    toolCall: { toolCallId: string; toolName: string; input: unknown };
  }) => void;
  /** Fires once per finished run. `messages` is the full composed view. */
  onFinish?: (
    msg: UIMessage,
    messages: UIMessage[],
    finishReason?: string,
  ) => void;
  onError?: (err: Error) => void;
}

/**
 * Owns one persistent stream SSE plus all per-thread state. Survives
 * component remounts because the registry holds a reference. Disposed
 * only when a different (orgSlug, threadId) is requested.
 */
class ThreadConnection {
  readonly key: string;
  readonly localMessages = new Store<Tagged<UIMessage>[]>([]);
  readonly streaming = new Store<UIMessage | null>(null);
  readonly status = new Store<ChatStreamStatus>("ready");
  readonly error = new Store<Error | null>(null);

  /** Mutated by the hook on every render. Mutators read at call time. */
  context: ThreadContext | null = null;
  /** Set by the active hook mount. Cleared on unmount. */
  observer: ThreadObserver | null = null;

  /** Public so tests can listen for abort. Don't call from production code. */
  readonly abort = new AbortController();
  // Demuxer state — split across these fields. The async fold loop reads
  // them after the sub closes; reconnect mutates them.
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
    void this.run();
  }

  dispose(): void {
    this.abort.abort();
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  async sendMessage(message: UIMessage, opts: RequestOptions): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const tagged: Tagged<UIMessage> = { ...message, [LOCAL_MARKER]: true };
    this.localMessages.update((prev) => [...prev, tagged]);
    this.status.set("submitted");
    this.error.set(null);

    const abort = new AbortController();
    this.inflightPost = abort;
    try {
      await this.post(message, opts, abort.signal);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.error.set(e);
      this.status.set("error");
      this.observer?.onError?.(e);
    } finally {
      if (this.inflightPost === abort) this.inflightPost = null;
    }
  }

  stop(): void {
    this.inflightPost?.abort();
    const s = this.status.get();
    if (s === "submitted" || s === "streaming") this.status.set("ready");
  }

  setMessages(
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ): void {
    const initialMessages = this.context?.initialMessages ?? [];
    const next =
      typeof updater === "function" ? updater(this.snapshotAll()) : updater;
    const serverIds = new Set(initialMessages.map((m) => m.id));
    const localOnly = next
      .filter((m) => !serverIds.has(m.id))
      .map((m): Tagged<UIMessage> => ({ ...m, [LOCAL_MARKER]: true }));
    this.localMessages.set(localOnly);
  }

  addToolOutput(
    args: {
      toolCallId: string;
      output?: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
    },
    opts: RequestOptions,
  ): void {
    const { toolCallId, output, state = "output-available", errorText } = args;
    this.patchLastAssistant((parts) =>
      parts.map((p: any) =>
        p && typeof p === "object" && p.toolCallId === toolCallId
          ? { ...p, state, output, errorText }
          : p,
      ),
    );
    this.maybeAutoSend(opts);
  }

  addToolApprovalResponse(
    args: { id: string; approved: boolean; reason?: string },
    opts: RequestOptions,
  ): void {
    const { id, approved, reason } = args;
    this.patchLastAssistant((parts) =>
      parts.map((p: any) =>
        p &&
        typeof p === "object" &&
        p.state === "approval-requested" &&
        p.approval?.id === id
          ? {
              ...p,
              state: "approval-responded",
              approval: { id, approved, reason },
            }
          : p,
      ),
    );
    this.maybeAutoSend(opts);
  }

  clearError(): void {
    if (this.status.get() === "error") {
      this.error.set(null);
      this.status.set("ready");
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Compose initialMessages + folded local + streaming. Public so the
   *  hook can use it for render-time `messages` without duplicating the
   *  merge logic.
   *
   *  Streaming is dropped if its id already appears in the merged list —
   *  this happens when a turn pauses with finishReason="tool-calls" (the
   *  message stays in `streaming` so subsequent tool-output chunks can fold
   *  in by toolCallId) and THREAD_MESSAGES then refetches, putting the same
   *  id into `initialMessages`. Server wins to avoid duplicate React keys. */
  snapshotAll(): UIMessage[] {
    const initialMessages = this.context?.initialMessages ?? [];
    const out = mergeWithServer(initialMessages, this.localMessages.get());
    const s = this.streaming.get();
    if (s && !out.some((m) => m.id === s.id)) out.push(s);
    return out;
  }

  private patchLastAssistant(
    update: (parts: UIMessage["parts"]) => UIMessage["parts"],
  ): void {
    const initialMessages = this.context?.initialMessages ?? [];
    const streaming = this.streaming.get();
    if (streaming) {
      this.streaming.set({ ...streaming, parts: update(streaming.parts) });
      return;
    }
    const localPrev = this.localMessages.get();
    const lastIdx = localPrev.length - 1;
    const localLast = lastIdx >= 0 ? localPrev[lastIdx] : undefined;
    if (localLast?.role === "assistant") {
      const next = [...localPrev];
      next[lastIdx] = {
        ...localLast,
        parts: update(localLast.parts),
      } as Tagged<UIMessage>;
      this.localMessages.set(next);
      return;
    }
    const serverLastIdx = initialMessages.length - 1;
    const serverLast =
      serverLastIdx >= 0 ? initialMessages[serverLastIdx] : undefined;
    if (serverLast?.role === "assistant") {
      const patched = {
        ...serverLast,
        parts: update(serverLast.parts),
      } as Tagged<UIMessage>;
      this.localMessages.set([...localPrev, patched]);
    }
  }

  private maybeAutoSend(opts: RequestOptions): void {
    if (!this.context) return;
    const s = this.status.get();
    if (s === "streaming" || s === "submitted") return;
    const all = this.snapshotAll();
    if (all.length === 0) return;
    if (!shouldAutoSend(all)) return;
    const last = all.at(-1);
    if (!last) return;
    this.status.set("submitted");
    void this.post(last, opts).catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.error.set(e);
      this.status.set("error");
      this.observer?.onError?.(e);
    });
  }

  private async post(
    message: UIMessage,
    opts: RequestOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const { system, ...rest } = opts;
    // Only attach the system prompt on a user turn. Tool-approval / output
    // continuations re-POST the assistant message; the server already has
    // the system context for the run, and including it would inject a
    // fresh `crypto.randomUUID()` system-message id into the body — making
    // the SHA-1 below effectively random per POST and defeating retry
    // collapsing.
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
    const bodyJson = JSON.stringify(body);
    // SHA-1 of the serialized body so byte-identical retries collapse onto
    // the same DBOS workflow, but the second POST in a multi-turn approval
    // (same assistant message id, different tool states) hashes differently
    // and dispatches a fresh run. Without this the server's idempotency
    // fallback keys on the last message id, which is stable across approvals
    // and silently drops the second-approval run.
    const digest = await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(bodyJson),
    );
    const idempotencyKey = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const url = `/api/${encodeURIComponent(this.orgSlug)}/decopilot/threads/${encodeURIComponent(this.threadId)}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
      },
      body: bodyJson,
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `POST /messages failed (${resp.status})`);
    }
  }

  /**
   * Persistent stream loop with reconnect/backoff. Terminal on HTTP
   * error, schema mismatch, or signal abort. Transient on TypeError /
   * mid-byte truncation / clean reader done — backoff and retry. The
   * server replays the in-flight run from JetStream's start on
   * reconnect, so we drop any partial in-flight fold first.
   */
  private async run(): Promise<void> {
    const url = `/api/${encodeURIComponent(this.orgSlug)}/decopilot/threads/${encodeURIComponent(this.threadId)}/stream`;
    let attempt = 0;
    let firstConnect = true;

    while (!this.abort.signal.aborted) {
      if (!firstConnect) {
        // Drop the in-flight fold before the upcoming replay so duplicate
        // deltas don't accumulate.
        this.forceCloseSubStream(true);
        this.streaming.set(null);
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
          this.handleStreamError(
            new Error(text || `GET /stream failed (${resp.status})`),
          );
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
            this.handleStreamError(value.error);
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

  private handleStreamError(err: Error): void {
    if (this.abort.signal.aborted) return;
    this.error.set(err);
    this.status.set("error");
    this.observer?.onError?.(err);
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
      // Null subController BEFORE close() so a synchronous onReconnect
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

  private async foldSubStream(
    sub: ReadableStream<UIMessageChunk>,
  ): Promise<void> {
    let last: UIMessage | null = null;
    const seed = this.streaming.get();
    const iter = readUIMessageStream({
      message: seed ?? undefined,
      stream: sub,
      onError: (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.error.set(err);
        this.status.set("error");
        this.observer?.onError?.(err);
      },
    });
    for await (const msg of iter) {
      last = msg;
      this.streaming.set(msg);
      if (this.status.get() !== "streaming") this.status.set("streaming");
    }
    const finishReason = this.pendingFinishReason;
    const discard = this.discardOnClose;
    this.subController = null;
    this.pendingFinishReason = undefined;
    this.discardOnClose = false;
    const finalMsg = last;
    // `tool-calls` means the assistant turn is pausing for tool / approval
    // resolution, not truly complete. Keep the folded message in `streaming`
    // so the next sub-stream's fold seeds with these parts and the AI SDK
    // can resolve `tool-output-available` / `tool-approval-request` chunks
    // against the original `tool-<name>` parts by toolCallId.
    const isResumable = finishReason === "tool-calls";
    if (finalMsg && !discard) {
      if (isResumable) {
        this.streaming.set(finalMsg);
      } else {
        this.localMessages.update((prev) => [...prev, finalMsg]);
        this.streaming.set(null);
      }
    }
    if (!discard) this.status.set("ready");
    if (finalMsg && !discard) {
      this.observer?.onFinish?.(finalMsg, this.snapshotAll(), finishReason);
    }
  }
}

// ── Module-scoped single slot ───────────────────────────────────────────────

let current: ThreadConnection | null = null;

/** Idempotent: same key → same instance. Different key → dispose + reopen. */
export function getOrOpenAttach(
  orgSlug: string,
  threadId: string,
): ThreadConnection {
  const key = `${orgSlug}::${threadId}`;
  if (current?.key === key) return current;
  current?.dispose();
  current = new ThreadConnection(orgSlug, threadId);
  return current;
}

/** Test-only: clear the active connection. Aborts in-flight fetch. */
export function __resetRegistry(): void {
  current?.dispose();
  current = null;
}
