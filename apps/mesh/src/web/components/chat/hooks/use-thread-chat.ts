/**
 * useThreadChat — useChat replacement built on the subscribe-model backend.
 *
 *   sendMessage  → POST /api/:org/decopilot/threads/:threadId/messages
 *                  (fire-and-forget, 202 { taskId })
 *   subscribe    → GET  /api/:org/decopilot/attach/:threadId?persistent=true
 *                  (one long-lived SSE per threadId — survives every run)
 *
 * The persistent /attach is the only source of assistant chunks. Sending
 * is a separate command with no return stream, so the SSE pipe is shared
 * across all observers of a thread (multiple tabs, passive watchers).
 *
 * Wire format on /attach is the AI-SDK UI-message stream, identical to
 * what `DefaultChatTransport` consumed. We parse SSE with
 * `parseJsonEventStream` and fold chunks into UIMessage state via
 * `readUIMessageStream`, splitting the persistent stream on
 * `{type: "finish"}` so each fold yields exactly one assistant message.
 *
 * Tool output and tool approval responses also POST to /messages — the
 * "request message" is the patched last assistant message. The
 * `sendAutomaticallyWhen` predicate decides whether to fire the
 * continuation; behavior matches useChat for the call sites here.
 */

import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type ChatAddToolApproveResponseFunction,
  type ChatAddToolOutputFunction,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { useRef, useSyncExternalStore } from "react";

export type ChatStreamStatus = "ready" | "submitted" | "streaming" | "error";

export interface UseChatStreamOptions<UI_MESSAGE extends UIMessage> {
  threadId: string;
  orgSlug: string;
  /** Server-persisted messages — used when idle. */
  initialMessages: UI_MESSAGE[];
  /**
   * Build the JSON body POSTed to /messages. Receives the full message
   * array; the caller is responsible for slicing to the request message
   * (typically the last non-system message + any system messages).
   */
  prepareBody: (args: {
    messages: UI_MESSAGE[];
    requestMetadata: unknown;
  }) => object;
  /**
   * Optional predicate. When the run completes and this returns true, the
   * hook auto-fires another POST with the current messages — used to
   * continue after tool output / approval response is added.
   */
  sendAutomaticallyWhen?: (state: { messages: UI_MESSAGE[] }) => boolean;
  onFinish?: (args: {
    message: UI_MESSAGE;
    messages: UI_MESSAGE[];
    finishReason?: string;
    isAbort: boolean;
    isDisconnect: boolean;
    isError: boolean;
  }) => void;
  onData?: (chunk: Extract<UIMessageChunk, { type: `data-${string}` }>) => void;
  onToolCall?: (toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => void;
  onError?: (error: Error) => void;
}

export interface UseChatStreamResult<UI_MESSAGE extends UIMessage> {
  messages: UI_MESSAGE[];
  status: ChatStreamStatus;
  error: Error | null;
  sendMessage: (
    message: UI_MESSAGE,
    opts?: { metadata?: unknown },
  ) => Promise<void>;
  stop: () => void;
  setMessages: (
    updater: UI_MESSAGE[] | ((prev: UI_MESSAGE[]) => UI_MESSAGE[]),
  ) => void;
  addToolOutput: ChatAddToolOutputFunction<UI_MESSAGE>;
  addToolApprovalResponse: ChatAddToolApproveResponseFunction;
  clearError: () => void;
}

/**
 * Hand-rolled emitter so React subscribers re-render on each update without
 * batching across the persistent stream's chunks.
 */
class Store<T> {
  private subs = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.subs.forEach((s) => s());
  }
  update(fn: (prev: T) => T): void {
    this.set(fn(this.value));
  }
  subscribe(s: () => void): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }
}

/**
 * Tag for the optimistically-appended user message — used so we can tell
 * which entries in `messages` came from `sendMessage()` vs the persistent
 * stream / server. We *don't* drop these on serverMessages refetch
 * directly; instead we compose with the server snapshot so a tab that's
 * passively observing another tab's send sees the user message arrive
 * via the server refetch and never has a duplicate.
 */
const LOCAL_MARKER = Symbol("local-user-message");
type Tagged<T> = T & { [LOCAL_MARKER]?: true };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useThreadChat<UI_MESSAGE extends UIMessage>(
  opts: UseChatStreamOptions<UI_MESSAGE>,
): UseChatStreamResult<UI_MESSAGE> {
  const {
    threadId,
    orgSlug,
    initialMessages,
    prepareBody,
    sendAutomaticallyWhen,
    onFinish,
    onData,
    onToolCall,
    onError,
  } = opts;

  // Stable callback refs so the long-lived subscribe loop reads the latest
  // closures without re-subscribing when consumers re-render.
  const cbRef = useRef({ onFinish, onData, onToolCall, onError });
  cbRef.current = { onFinish, onData, onToolCall, onError };

  // ── Stores (re-render only on actual changes) ─────────────────────────
  const localMessagesStore = useRef<Store<Tagged<UI_MESSAGE>[]>>(
    null as unknown as Store<Tagged<UI_MESSAGE>[]>,
  );
  if (!localMessagesStore.current) {
    localMessagesStore.current = new Store<Tagged<UI_MESSAGE>[]>([]);
  }
  const streamingStore = useRef<Store<UI_MESSAGE | null>>(
    null as unknown as Store<UI_MESSAGE | null>,
  );
  if (!streamingStore.current) streamingStore.current = new Store(null);
  const statusStore = useRef<Store<ChatStreamStatus>>(
    null as unknown as Store<ChatStreamStatus>,
  );
  if (!statusStore.current) statusStore.current = new Store("ready");
  const errorStore = useRef<Store<Error | null>>(
    null as unknown as Store<Error | null>,
  );
  if (!errorStore.current) errorStore.current = new Store(null);

  // Subscribe React to the stores
  const localMessages = useSyncExternalStore(
    (cb) => localMessagesStore.current.subscribe(cb),
    () => localMessagesStore.current.get(),
    () => localMessagesStore.current.get(),
  );
  const streamingMessage = useSyncExternalStore(
    (cb) => streamingStore.current.subscribe(cb),
    () => streamingStore.current.get(),
    () => streamingStore.current.get(),
  );
  const status = useSyncExternalStore(
    (cb) => statusStore.current.subscribe(cb),
    () => statusStore.current.get(),
    () => statusStore.current.get(),
  );
  const error = useSyncExternalStore(
    (cb) => errorStore.current.subscribe(cb),
    () => errorStore.current.get(),
    () => errorStore.current.get(),
  );

  // ── Persistent /attach connection ─────────────────────────────────────
  // Created once per (orgSlug, threadId) pair. Stays open for the lifetime
  // of this hook instance; the next thread switch tears it down via the
  // subscribe key in useSyncExternalStore below.
  const connRef = useRef<{
    key: string;
    abort: AbortController;
  } | null>(null);

  const connKey = `${orgSlug}::${threadId}`;
  if (connRef.current && connRef.current.key !== connKey) {
    connRef.current.abort.abort();
    connRef.current = null;
    // Stale local state from the previous thread would render alongside
    // the new thread's server snapshot until the user starts interacting
    // — clear everything when switching threads.
    localMessagesStore.current.set([]);
    streamingStore.current.set(null);
    statusStore.current.set("ready");
    errorStore.current.set(null);
  }
  if (!connRef.current && threadId) {
    const abort = new AbortController();
    connRef.current = { key: connKey, abort };
    void runPersistentLoop({
      url: `/api/${encodeURIComponent(orgSlug)}/decopilot/attach/${encodeURIComponent(threadId)}?persistent=true`,
      signal: abort.signal,
      onChunk: (chunk) => handleChunkFanOut(chunk),
      onError: (err) => {
        errorStore.current.set(err);
        statusStore.current.set("error");
        cbRef.current.onError?.(err);
      },
    });
  }

  // Demuxer: feeds incoming chunks into the *current* readUIMessageStream
  // sub-stream. Boundaries are `{type: "finish"}` chunks.
  const demuxRef = useRef<{
    subController: ReadableStreamDefaultController<UIMessageChunk> | null;
    consume: () => Promise<void>;
  }>({ subController: null, consume: async () => {} });

  function ensureSubStream(): ReadableStreamDefaultController<UIMessageChunk> {
    if (demuxRef.current.subController) return demuxRef.current.subController;
    let controllerOut: ReadableStreamDefaultController<UIMessageChunk>;
    const sub = new ReadableStream<UIMessageChunk>({
      start(c) {
        controllerOut = c;
      },
    });
    // biome-ignore lint/style/noNonNullAssertion: set synchronously in start()
    demuxRef.current.subController = controllerOut!;

    // Drive readUIMessageStream over the sub. The yields update the
    // "streaming message" view; when the sub closes (finish chunk seen),
    // we promote the final message into localMessages.
    void (async () => {
      let last: UI_MESSAGE | null = null;
      const seed = streamingStore.current.get();
      const iter = readUIMessageStream<UI_MESSAGE>({
        message: seed ?? undefined,
        stream: sub,
        onError: (e) => {
          const err = e instanceof Error ? e : new Error(String(e));
          errorStore.current.set(err);
          statusStore.current.set("error");
          cbRef.current.onError?.(err);
        },
      });
      for await (const msg of iter) {
        last = msg;
        streamingStore.current.set(msg);
        if (statusStore.current.get() !== "streaming") {
          statusStore.current.set("streaming");
        }
      }
      // Sub-stream closed — the finish chunk landed.
      demuxRef.current.subController = null;
      const finalMsg = last;
      if (finalMsg) {
        localMessagesStore.current.update((prev) => [...prev, finalMsg]);
        streamingStore.current.set(null);
      }
      statusStore.current.set("ready");
      if (finalMsg) {
        cbRef.current.onFinish?.({
          message: finalMsg,
          messages: snapshotAll(),
          isAbort: false,
          isDisconnect: false,
          isError: false,
        });
      }
      // Auto-continue (tool output / approval response continuation).
      maybeAutoSend();
    })();
    // biome-ignore lint/style/noNonNullAssertion: set synchronously above
    return controllerOut!;
  }

  function handleChunkFanOut(chunk: UIMessageChunk): void {
    // Dispatch the data-* and tool-call callbacks before folding so
    // consumers see them in arrival order.
    if (chunk.type.startsWith("data-")) {
      cbRef.current.onData?.(
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
      cbRef.current.onToolCall?.({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
      });
    }

    const sub = ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      sub.close();
    }
  }

  function snapshotAll(): UI_MESSAGE[] {
    const streaming = streamingStore.current.get();
    const local = localMessagesStore.current.get();
    const out = mergeWithServer(initialMessages, local);
    if (streaming) out.push(streaming);
    return out as UI_MESSAGE[];
  }

  // ── Public API ────────────────────────────────────────────────────────
  const inflightAbortRef = useRef<AbortController | null>(null);

  const post = async (body: object, signal?: AbortSignal): Promise<void> => {
    const url = `/api/${encodeURIComponent(orgSlug)}/decopilot/threads/${encodeURIComponent(threadId)}/messages`;
    const resp = await fetch(url, {
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
  };

  const sendMessage = async (
    message: UI_MESSAGE,
    sendOpts?: { metadata?: unknown },
  ): Promise<void> => {
    const tagged: Tagged<UI_MESSAGE> = { ...message, [LOCAL_MARKER]: true };
    localMessagesStore.current.update((prev) => [...prev, tagged]);
    statusStore.current.set("submitted");
    errorStore.current.set(null);

    const messagesForBody = snapshotAll();
    const body = prepareBody({
      messages: messagesForBody,
      requestMetadata: sendOpts?.metadata,
    });

    const abort = new AbortController();
    inflightAbortRef.current = abort;
    try {
      await post(body, abort.signal);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      errorStore.current.set(e);
      statusStore.current.set("error");
      cbRef.current.onError?.(e);
    } finally {
      if (inflightAbortRef.current === abort) inflightAbortRef.current = null;
    }
  };

  const stop = (): void => {
    inflightAbortRef.current?.abort();
    // Server-side cancellation is the caller's responsibility (POST /cancel
    // in chat-context); we just abort the in-flight POST here.
    if (
      statusStore.current.get() === "submitted" ||
      statusStore.current.get() === "streaming"
    ) {
      statusStore.current.set("ready");
    }
  };

  const setMessages = (
    updater: UI_MESSAGE[] | ((prev: UI_MESSAGE[]) => UI_MESSAGE[]),
  ): void => {
    const next =
      typeof updater === "function"
        ? (updater as (p: UI_MESSAGE[]) => UI_MESSAGE[])(snapshotAll())
        : updater;
    // Drop everything that came from the server snapshot — keep only the
    // remainder as local additions.
    const serverIds = new Set(initialMessages.map((m) => m.id));
    const localOnly = next
      .filter((m) => !serverIds.has(m.id))
      .map((m): Tagged<UI_MESSAGE> => ({ ...m, [LOCAL_MARKER]: true }));
    localMessagesStore.current.set(localOnly);
  };

  const patchLastAssistant = (
    update: (parts: UI_MESSAGE["parts"]) => UI_MESSAGE["parts"],
  ): void => {
    const streaming = streamingStore.current.get();
    if (streaming) {
      streamingStore.current.set({
        ...streaming,
        parts: update(streaming.parts),
      });
      return;
    }
    localMessagesStore.current.update((prev) => {
      const lastIdx = prev.length - 1;
      if (lastIdx < 0) return prev;
      const last = prev[lastIdx];
      if (!last || last.role !== "assistant") return prev;
      const next = [...prev];
      next[lastIdx] = {
        ...last,
        parts: update(last.parts),
      } as Tagged<UI_MESSAGE>;
      return next;
    });
  };

  const addToolOutput = ((args: {
    toolCallId: string;
    output?: unknown;
    state?: "output-available" | "output-error";
    errorText?: string;
  }) => {
    const { toolCallId, output, state = "output-available", errorText } = args;
    patchLastAssistant((parts) =>
      parts.map((p: any) =>
        p && typeof p === "object" && p.toolCallId === toolCallId
          ? { ...p, state, output, errorText }
          : p,
      ),
    );
    maybeAutoSend();
  }) as ChatAddToolOutputFunction<UI_MESSAGE>;

  const addToolApprovalResponse: ChatAddToolApproveResponseFunction = ({
    id,
    approved,
    reason,
  }) => {
    patchLastAssistant((parts) =>
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
    maybeAutoSend();
  };

  const clearError = (): void => {
    if (statusStore.current.get() === "error") {
      errorStore.current.set(null);
      statusStore.current.set("ready");
    }
  };

  function maybeAutoSend(): void {
    if (!sendAutomaticallyWhen) return;
    const s = statusStore.current.get();
    if (s === "streaming" || s === "submitted") return;
    const all = snapshotAll();
    if (!sendAutomaticallyWhen({ messages: all })) return;
    const last = all[all.length - 1];
    if (!last) return;
    // Continuation: the request "new message" is the patched last
    // assistant message (the same shape useChat would POST after
    // addToolOutput / addToolApprovalResponse).
    statusStore.current.set("submitted");
    const body = prepareBody({ messages: all, requestMetadata: {} });
    void post(body).catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      errorStore.current.set(e);
      statusStore.current.set("error");
      cbRef.current.onError?.(e);
    });
  }

  // Compose messages for consumers. The server snapshot wins by id; local
  // entries supplement until the server catches up.
  const messages = (() => {
    const out = mergeWithServer(initialMessages, localMessages);
    if (streamingMessage) out.push(streamingMessage);
    return out as UI_MESSAGE[];
  })();

  return {
    messages,
    status,
    error,
    sendMessage,
    stop,
    setMessages,
    addToolOutput,
    addToolApprovalResponse,
    clearError,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compose a "current view" of messages from the server snapshot plus local
 * extras (optimistic user messages, completed assistant messages whose DB
 * persistence hasn't propagated yet). De-dupe by id, server wins.
 */
function mergeWithServer<UI_MESSAGE extends UIMessage>(
  server: UI_MESSAGE[],
  local: Tagged<UI_MESSAGE>[],
): UI_MESSAGE[] {
  if (local.length === 0) return server.slice();
  const serverIds = new Set(server.map((m) => m.id));
  const extras = local.filter((m) => !serverIds.has(m.id));
  if (extras.length === 0) return server.slice();
  return [...server, ...extras];
}

async function runPersistentLoop(args: {
  url: string;
  signal: AbortSignal;
  onChunk: (chunk: UIMessageChunk) => void;
  onError: (err: Error) => void;
}): Promise<void> {
  const { url, signal, onChunk, onError } = args;
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
      throw new Error(text || `GET /attach failed (${resp.status})`);
    }
    const parsed = parseJsonEventStream({
      stream: resp.body,
      schema: uiMessageChunkSchema,
    });
    const reader = parsed.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value.success) {
        onError(value.error);
        return;
      }
      onChunk(value.value as UIMessageChunk);
    }
  } catch (err) {
    if (signal.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
