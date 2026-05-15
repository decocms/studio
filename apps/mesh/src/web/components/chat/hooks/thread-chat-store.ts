import {
  type ChatAddToolApproveResponseFunction,
  type ChatAddToolOutputFunction,
  parseJsonEventStream,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai";

export type ChatStreamStatus = "ready" | "submitted" | "streaming" | "error";

const LOCAL_MARKER = Symbol("local-user-message");
type Tagged<T> = T & { [LOCAL_MARKER]?: true };

export interface ThreadChatHandlers<M extends UIMessage> {
  prepareBody: (args: { messages: M[]; requestMetadata: unknown }) => object;
  sendAutomaticallyWhen?: (state: { messages: M[] }) => boolean;
  onFinish?: (args: {
    message: M;
    messages: M[];
    finishReason?: string;
    isAbort: boolean;
    isDisconnect: boolean;
    isError: boolean;
  }) => void;
  onData?: (chunk: Extract<UIMessageChunk, { type: `data-${string}` }>) => void;
  onToolCall?: (event: {
    toolCall: { toolCallId: string; toolName: string; input: unknown };
  }) => void;
  onError?: (error: Error) => void;
}

export interface ThreadChatSnapshot<M extends UIMessage> {
  local: M[];
  streaming: M | null;
  status: ChatStreamStatus;
  error: Error | null;
}

export interface PersistentLoopFn {
  (args: {
    url: string;
    signal: AbortSignal;
    onChunk: (chunk: UIMessageChunk) => void;
    onError: (err: Error) => void;
    onReconnect?: () => void;
  }): Promise<void>;
}

export interface ThreadChatStoreOptions<M extends UIMessage> {
  handlersRef: { current: ThreadChatHandlers<M> };
  /**
   * Live read of the server-persisted message snapshot. Used by
   * `patchLastAssistant` as a fallback when the thread is opened
   * mid-`requires_action` and the assistant we need to patch lives only
   * in the server snapshot (not in local or streaming yet).
   */
  initialMessagesRef?: { current: UIMessage[] };
  persistentLoop?: PersistentLoopFn;
  fetchImpl?: typeof fetch;
  sseFinishBackstopMs?: number;
}

export class ThreadChatStore<M extends UIMessage> {
  private snapshot: ThreadChatSnapshot<M> = {
    local: [],
    streaming: null,
    status: "ready",
    error: null,
  };
  private listeners = new Set<() => void>();
  private readonly handlersRef: { current: ThreadChatHandlers<M> };
  private readonly initialMessagesRef: { current: UIMessage[] } | undefined;
  private readonly persistentLoop: PersistentLoopFn;
  private readonly fetchImpl: typeof fetch;
  private readonly sseFinishBackstopMs: number;
  private connArgs: { orgSlug: string; threadId: string } | null = null;
  private abortCtl: AbortController | null = null;
  private inflightPostAbort: AbortController | null = null;
  private demux: {
    subController: ReadableStreamDefaultController<UIMessageChunk> | null;
    pendingFinishReason: string | undefined;
    discardOnClose: boolean;
    pendingSseBackstops: number;
  } = {
    subController: null,
    pendingFinishReason: undefined,
    discardOnClose: false,
    pendingSseBackstops: 0,
  };

  constructor(options: ThreadChatStoreOptions<M>) {
    this.handlersRef = options.handlersRef;
    this.initialMessagesRef = options.initialMessagesRef;
    this.persistentLoop = options.persistentLoop ?? runPersistentLoop;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sseFinishBackstopMs = options.sseFinishBackstopMs ?? 1500;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ThreadChatSnapshot<M> => this.snapshot;

  private update(patch: Partial<ThreadChatSnapshot<M>>): void {
    const next = { ...this.snapshot, ...patch };
    // Skip notification if no field actually changed (preserves snapshot identity).
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof ThreadChatSnapshot<M>>) {
      if (!Object.is(next[k], this.snapshot[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  private get apiBase(): string {
    if (!this.connArgs) throw new Error("ThreadChatStore: not connected");
    const { orgSlug, threadId } = this.connArgs;
    return `/api/${encodeURIComponent(orgSlug)}/decopilot/threads/${encodeURIComponent(threadId)}`;
  }

  private async post(body: object, signal?: AbortSignal): Promise<void> {
    const resp = await this.fetchImpl(`${this.apiBase}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `POST /messages failed (${resp.status})`);
    }
  }

  /** Composed view: local + streaming (used by handlers + auto-send). */
  private snapshotAll(): M[] {
    const { local, streaming } = this.snapshot;
    return streaming ? [...local, streaming] : local.slice();
  }

  private ensureSubStream(): ReadableStreamDefaultController<UIMessageChunk> {
    if (this.demux.subController) return this.demux.subController;
    this.demux.pendingFinishReason = undefined;
    let controllerOut!: ReadableStreamDefaultController<UIMessageChunk>;
    const sub = new ReadableStream<UIMessageChunk>({
      start: (c) => {
        controllerOut = c;
      },
    });
    this.demux.subController = controllerOut;

    void (async () => {
      let last: M | null = null;
      const seed = this.snapshot.streaming;
      const iter = readUIMessageStream<M>({
        message: seed ?? undefined,
        stream: sub,
        onError: (e) => {
          const err = e instanceof Error ? e : new Error(String(e));
          this.update({ error: err, status: "error" });
          this.handlersRef.current.onError?.(err);
        },
      });
      for await (const msg of iter) {
        last = msg;
        if (this.snapshot.status !== "streaming") {
          this.update({ streaming: msg, status: "streaming" });
        } else {
          this.update({ streaming: msg });
        }
      }
      const finishReason = this.demux.pendingFinishReason;
      const discard = this.demux.discardOnClose;
      this.demux.subController = null;
      this.demux.pendingFinishReason = undefined;
      this.demux.discardOnClose = false;

      if (last && !discard) {
        this.update({
          local: [...this.snapshot.local, last],
          streaming: null,
          status: "ready",
        });
        this.handlersRef.current.onFinish?.({
          message: last,
          messages: this.snapshotAll(),
          finishReason,
          isAbort: false,
          isDisconnect: false,
          isError: false,
        });
      } else if (!discard) {
        this.update({ status: "ready" });
      }
      this.maybeAutoSend();
    })();
    return controllerOut;
  }

  // @ts-ignore TS6133 — used by Tasks 6/9 (SSE backstop + reconnect/thread-switch discard).
  private forceCloseSubStream(discard = false): void {
    const ctrl = this.demux.subController;
    if (!ctrl) return;
    this.demux.discardOnClose = discard;
    this.demux.subController = null;
    try {
      ctrl.close();
    } catch {
      /* readUIMessageStream finally handles promotion */
    }
  }

  /** Patch the last assistant message (local or streaming). */
  private patchLastAssistant(update: (parts: M["parts"]) => M["parts"]): void {
    const { streaming, local } = this.snapshot;
    if (streaming) {
      this.update({
        streaming: { ...streaming, parts: update(streaming.parts) },
      });
      return;
    }
    const lastIdx = local.length - 1;
    const last = lastIdx >= 0 ? local[lastIdx] : undefined;
    if (last && last.role === "assistant") {
      const next = [...local];
      next[lastIdx] = { ...last, parts: update(last.parts) } as Tagged<M>;
      this.update({ local: next });
      return;
    }
    // Mid-`requires_action` open: the assistant we need to patch lives only
    // in the server snapshot (no streaming, no local additions yet). Promote
    // a patched copy to local; mergeWithServer at the hook layer will let it
    // win on shared id so the continuation POST body carries the patch.
    const server = this.initialMessagesRef?.current;
    const serverLast = server && server.length > 0 ? server[server.length - 1] : undefined;
    if (serverLast && serverLast.role === "assistant") {
      const patched = {
        ...serverLast,
        parts: update(serverLast.parts as M["parts"]),
      } as Tagged<M>;
      this.update({ local: [...local, patched] });
    }
  }

  /** Auto-send if sendAutomaticallyWhen condition is met. */
  private maybeAutoSend(metadata?: unknown): void {
    const handlers = this.handlersRef.current;
    if (!handlers.sendAutomaticallyWhen) return;
    const s = this.snapshot.status;
    if (s === "streaming" || s === "submitted") return;
    const all = this.snapshotAll();
    if (!handlers.sendAutomaticallyWhen({ messages: all })) return;
    if (all.length === 0) return;
    this.update({ status: "submitted" });
    const body = handlers.prepareBody({
      messages: all,
      requestMetadata: metadata ?? {},
    });
    void this.post(body).catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.update({ error: e, status: "error" });
      handlers.onError?.(e);
    });
  }

  // @ts-ignore TS6133 — wired by runPersistentLoop in Task 9; called directly by tests.
  private handleChunk(chunk: UIMessageChunk): void {
    // Fan out side-effect callbacks before folding.
    if (chunk.type.startsWith("data-")) {
      this.handlersRef.current.onData?.(
        chunk as Extract<UIMessageChunk, { type: `data-${string}` }>,
      );
    }
    if (chunk.type === "tool-input-available") {
      const c = chunk as {
        toolCallId: string;
        toolName: string;
        input: unknown;
      };
      this.handlersRef.current.onToolCall?.({
        toolCall: {
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        },
      });
    }

    // Continuation seeding: promote local last-assistant into streaming
    // when the new sub-stream's start chunk carries its messageId.
    if (
      chunk.type === "start" &&
      !this.demux.subController &&
      this.snapshot.streaming === null
    ) {
      const startMessageId = (chunk as { messageId?: string }).messageId;
      if (startMessageId) {
        const { local } = this.snapshot;
        const last = local[local.length - 1];
        if (last && last.role === "assistant" && last.id === startMessageId) {
          this.update({
            streaming: last,
            local: local.slice(0, -1),
          });
        }
      }
    }

    const sub = this.ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      const finishChunk = chunk as { finishReason?: string };
      this.demux.pendingFinishReason = finishChunk.finishReason;
      this.demux.pendingSseBackstops--;
      sub.close();
    }
  }

  // ── Public methods ─────────────────────────────────────────────────
  connect(args: { orgSlug: string; threadId: string }): void {
    const switching =
      this.connArgs !== null &&
      (this.connArgs.orgSlug !== args.orgSlug ||
        this.connArgs.threadId !== args.threadId);

    if (switching) {
      this.disconnect();
      // Full reset.
      this.snapshot = {
        local: [],
        streaming: null,
        status: "ready",
        error: null,
      };
      this.listeners.forEach((l) => l());
    }

    // Idempotent: if already connected to this (org, thread), no-op.
    if (this.connArgs && !switching) return;

    this.connArgs = args;
    const abort = new AbortController();
    this.abortCtl = abort;
    const url = `/api/${encodeURIComponent(args.orgSlug)}/decopilot/attach/${encodeURIComponent(args.threadId)}`;
    void this.persistentLoop({
      url,
      signal: abort.signal,
      onChunk: (chunk) => this.handleChunk(chunk),
      onError: (err) => {
        if (abort.signal.aborted) return;
        this.update({ error: err, status: "error" });
        this.handlersRef.current.onError?.(err);
      },
      onReconnect: () => {
        this.forceCloseSubStream(true);
        this.update({ streaming: null });
      },
    });
  }

  disconnect(): void {
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.connArgs = null;
    this.forceCloseSubStream(true);
  }

  notifySseFinish(): void {
    this.demux.pendingSseBackstops++;
    if (this.demux.pendingSseBackstops <= 0) return;
    setTimeout(() => {
      if (this.demux.pendingSseBackstops <= 0) return;
      this.demux.pendingSseBackstops--;
      this.forceCloseSubStream();
    }, this.sseFinishBackstopMs);
  }

  async sendMessage(message: M, opts?: { metadata?: unknown }): Promise<void> {
    const tagged: Tagged<M> = { ...message, [LOCAL_MARKER]: true };
    this.update({
      local: [...this.snapshot.local, tagged],
      status: "submitted",
      error: null,
    });

    const body = this.handlersRef.current.prepareBody({
      messages: this.snapshotAll(),
      requestMetadata: opts?.metadata,
    });

    const abort = new AbortController();
    this.inflightPostAbort = abort;
    try {
      await this.post(body, abort.signal);
    } catch (err) {
      // Caller-initiated abort (stop()/disconnect) is not an error —
      // the status has already been flipped back to ready/reset.
      if (abort.signal.aborted) return;
      const e = err instanceof Error ? err : new Error(String(err));
      this.update({ error: e, status: "error" });
      this.handlersRef.current.onError?.(e);
    } finally {
      if (this.inflightPostAbort === abort) this.inflightPostAbort = null;
    }
  }

  stop(): void {
    this.inflightPostAbort?.abort();
    const s = this.snapshot.status;
    if (s === "submitted" || s === "streaming") {
      this.update({ status: "ready" });
    }
  }

  setMessages(serverSnapshot: M[], updater: M[] | ((prev: M[]) => M[])): void {
    const composed = mergeWithServer(serverSnapshot, this.snapshot.local);
    const withStreaming = this.snapshot.streaming
      ? [...composed, this.snapshot.streaming]
      : composed;
    const next =
      typeof updater === "function"
        ? (updater as (p: M[]) => M[])(withStreaming)
        : updater;
    const serverIds = new Set(serverSnapshot.map((m) => m.id));
    const localOnly = next
      .filter((m) => !serverIds.has(m.id))
      .map((m): Tagged<M> => ({ ...m, [LOCAL_MARKER]: true }));
    this.update({ local: localOnly });
  }

  addToolOutput: ChatAddToolOutputFunction<M> = ((args: {
    toolCallId: string;
    output?: unknown;
    state?: "output-available" | "output-error";
    errorText?: string;
    options?: { metadata?: unknown };
  }) => {
    const {
      toolCallId,
      output,
      state = "output-available",
      errorText,
      options,
    } = args;
    this.patchLastAssistant(
      (parts) =>
        parts.map((p: unknown) =>
          p &&
          typeof p === "object" &&
          (p as { toolCallId?: string }).toolCallId === toolCallId
            ? { ...(p as object), state, output, errorText }
            : p,
        ) as M["parts"],
    );
    this.maybeAutoSend(options?.metadata);
  }) as ChatAddToolOutputFunction<M>;

  addToolApprovalResponse: ChatAddToolApproveResponseFunction = ({
    id,
    approved,
    reason,
    options,
  }) => {
    this.patchLastAssistant(
      (parts) =>
        parts.map((p: unknown) => {
          const part = p as { state?: string; approval?: { id?: string } };
          return part &&
            typeof p === "object" &&
            part.state === "approval-requested" &&
            part.approval?.id === id
            ? {
                ...(p as object),
                state: "approval-responded",
                approval: { id, approved, reason },
              }
            : p;
        }) as M["parts"],
    );
    this.maybeAutoSend(options?.metadata);
  };

  clearError(): void {
    if (this.snapshot.status === "error") {
      this.update({ error: null, status: "ready" });
    }
  }
}

export function mergeWithServer<M extends UIMessage>(
  server: M[],
  local: M[],
): M[] {
  if (local.length === 0) return server.slice();
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverIds = new Set(server.map((m) => m.id));
  const merged = server.map((m) => localById.get(m.id) ?? m);
  for (const m of local) if (!serverIds.has(m.id)) merged.push(m);
  return merged;
}

/**
 * Persistent SSE attach loop with auto-reconnect.
 *
 * One open connection per (tab, thread) is the only delivery path for
 * assistant chunks in the subscribe model. Proxies that hard-cut TCP
 * after N minutes, network blips, and server-side stream EOFs all
 * surface here as either a `TypeError` from `fetch` / `reader.read` or
 * a clean `reader.done` mid-run — we treat both as transient and
 * reconnect with exponential backoff (1s → 2s → 4s → … capped at 30s).
 *
 * Terminal vs transient:
 *   - 4xx / 5xx HTTP response  → terminal (server explicitly rejected)
 *   - Schema parse error       → terminal (wire-format mismatch)
 *   - `signal.aborted`         → terminal (unmount / thread switch)
 *   - everything else          → transient, reconnect
 *
 * The new connection uses `DeliverPolicy.All` server-side, so the
 * in-flight run's chunks are re-delivered from JetStream's start. The
 * caller's `onReconnect` hook should drop any partially-folded message
 * before the replay so duplicated deltas don't accumulate.
 */
const runPersistentLoop: PersistentLoopFn = async (args) => {
  const { url, signal, onChunk, onError, onReconnect } = args;
  let attempt = 0;
  let firstConnect = true;
  const BASE_DELAY_MS = 1_000;
  const MAX_DELAY_MS = 30_000;

  while (!signal.aborted) {
    if (!firstConnect) onReconnect?.();
    firstConnect = false;

    let cleanExit = false;
    try {
      const resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (resp.status === 204 || !resp.body) return;
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        onError(new Error(text || `GET /attach failed (${resp.status})`));
        return; // terminal — server-side rejection
      }
      // Reset backoff once a connection is open and the headers are ok.
      attempt = 0;
      const parsed = parseJsonEventStream({
        stream: resp.body,
        schema: uiMessageChunkSchema,
      });
      const reader = parsed.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Server-side stream ended mid-run (proxy hard-cut, NATS
          // hiccup, pod recycle). Treat as transient and reconnect.
          cleanExit = true;
          break;
        }
        if (!value.success) {
          onError(value.error);
          return; // terminal — schema mismatch
        }
        onChunk(value.value as UIMessageChunk);
      }
    } catch (err) {
      if (signal.aborted) return;
      // Transient (TypeError / network unreachable / mid-byte
      // truncation): fall through to backoff + reconnect. The actual
      // error is intentionally not surfaced to consumers — reconnect
      // is the whole point of the loop.
      void err;
    }

    if (signal.aborted) return;
    // Backoff before next attempt (zero-delay on the first reconnect
    // after a `done`-style clean exit so quick proxy cuts resume fast).
    const delay = cleanExit
      ? 0
      : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    attempt++;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener(
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
};

export type { Tagged };
export { LOCAL_MARKER };
