import {
  type ChatAddToolApproveResponseFunction,
  type ChatAddToolOutputFunction,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
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
    this.persistentLoop = options.persistentLoop ?? runPersistentLoop;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sseFinishBackstopMs = options.sseFinishBackstopMs ?? 1500;
    // Touch each field so TS doesn't flag them as unused in this scaffold —
    // real readers land in Tasks 2-9.
    void this.persistentLoop;
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

  /** Auto-continuation placeholder — filled in Task 8. */
  private maybeAutoSend(_metadata?: unknown): void {}

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
    // Continuation seeding is added in Task 7.
    const sub = this.ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      const finishChunk = chunk as { finishReason?: string };
      this.demux.pendingFinishReason = finishChunk.finishReason;
      this.demux.pendingSseBackstops--;
      sub.close();
    }
  }

  // ── Public methods (stubs filled in later tasks) ────────────────────
  connect(args: { orgSlug: string; threadId: string }): void {
    if (
      this.connArgs &&
      (this.connArgs.orgSlug !== args.orgSlug ||
        this.connArgs.threadId !== args.threadId)
    ) {
      // Thread switch — reset state. Filled in Task 9 with sub-stream teardown.
      this.snapshot = {
        local: [],
        streaming: null,
        status: "ready",
        error: null,
      };
      this.listeners.forEach((l) => l());
    }
    this.connArgs = args;
    // SSE connection is opened in Task 9.
  }

  disconnect(): void {
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.connArgs = null;
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
      const e = err instanceof Error ? err : new Error(String(err));
      this.update({ error: e, status: "error" });
      this.handlersRef.current.onError?.(e);
    } finally {
      if (this.inflightPostAbort === abort) this.inflightPostAbort = null;
    }
  }

  stop(): void {
    throw new Error("not implemented");
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

  addToolOutput: ChatAddToolOutputFunction<M> = (() => {
    throw new Error("not implemented");
  }) as ChatAddToolOutputFunction<M>;

  addToolApprovalResponse: ChatAddToolApproveResponseFunction = () => {
    throw new Error("not implemented");
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

// Placeholder — full impl in Task 9.
const runPersistentLoop: PersistentLoopFn = () => {
  throw new Error("runPersistentLoop: not implemented (Task 9)");
};

export type { Tagged };
export { LOCAL_MARKER };
