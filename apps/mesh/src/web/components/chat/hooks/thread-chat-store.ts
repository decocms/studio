import type {
  ChatAddToolApproveResponseFunction,
  ChatAddToolOutputFunction,
  UIMessage,
  UIMessageChunk,
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

  constructor(options: ThreadChatStoreOptions<M>) {
    this.handlersRef = options.handlersRef;
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

  // ── Public methods (stubs filled in later tasks) ────────────────────
  connect(_args: { orgSlug: string; threadId: string }): void {
    throw new Error("not implemented");
  }
  disconnect(): void {
    throw new Error("not implemented");
  }
  notifySseFinish(): void {
    throw new Error("not implemented");
  }
  async sendMessage(_m: M, _o?: { metadata?: unknown }): Promise<void> {
    throw new Error("not implemented");
  }
  stop(): void {
    throw new Error("not implemented");
  }
  setMessages(_s: M[], _u: M[] | ((prev: M[]) => M[])): void {
    throw new Error("not implemented");
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

// Placeholder — full impl in Task 9.
const runPersistentLoop: PersistentLoopFn = async () => {};

export type { Tagged };
export { LOCAL_MARKER };
