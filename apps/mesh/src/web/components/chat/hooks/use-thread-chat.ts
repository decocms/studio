/**
 * useThreadChat — useChat replacement built on the subscribe-model backend.
 *
 *   sendMessage  → POST /api/:org/decopilot/threads/:threadId/messages
 *                  (fire-and-forget, 202 { taskId })
 *   subscribe    → GET  /api/:org/decopilot/attach/:threadId
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
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";

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
  /**
   * Shape matches useChat's `ChatOnToolCallCallback` — `{ toolCall: {...} }`
   * — so existing handlers like `useInvalidateCollectionsOnToolCall`
   * (which read `event.toolCall.toolName`) keep working unchanged.
   */
  onToolCall?: (event: {
    toolCall: { toolCallId: string; toolName: string; input: unknown };
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
  // Lifecycle is driven by useSyncExternalStore: React calls `subscribe`
  // on mount (opens the fetch) and the returned cleanup on unmount
  // (aborts the fetch). This means StrictMode's double-mount and any
  // future cleanup-on-route-change automatically tear the connection
  // down — without it the dev server's connection pool fills up with
  // orphaned SSEs and starts hanging requests after a few HMR cycles.
  //
  // `subscribeRef` is rebuilt only when threadId / orgSlug change, so
  // re-renders don't churn the SSE.
  const connKey = `${orgSlug}::${threadId}`;
  const prevKeyRef = useRef(connKey);
  const subscribeRef = useRef<((notify: () => void) => () => void) | null>(
    null,
  );
  if (!subscribeRef.current || prevKeyRef.current !== connKey) {
    if (prevKeyRef.current !== connKey) {
      // Thread switched — discard any stale local snapshot.
      localMessagesStore.current.set([]);
      streamingStore.current.set(null);
      statusStore.current.set("ready");
      errorStore.current.set(null);
    }
    prevKeyRef.current = connKey;
    subscribeRef.current = (_notify: () => void) => {
      if (!threadId) return () => {};
      const abort = new AbortController();
      void runPersistentLoop({
        url: `/api/${encodeURIComponent(orgSlug)}/decopilot/attach/${encodeURIComponent(threadId)}`,
        signal: abort.signal,
        onChunk: (chunk) => handleChunkFanOut(chunk),
        onError: (err) => {
          if (abort.signal.aborted) return;
          errorStore.current.set(err);
          statusStore.current.set("error");
          cbRef.current.onError?.(err);
        },
        onReconnect: () => {
          // The next /attach connect uses `DeliverPolicy.All` and will
          // replay every chunk for the current in-flight run from its
          // start. Drop our in-flight sub-stream's partial fold and
          // clear the streaming view so the replay re-folds cleanly
          // without duplicating deltas into the previous state.
          forceCloseCurrentSubStream(true);
          streamingStore.current.set(null);
        },
      });
      return () => abort.abort();
    };
  }
  useSyncExternalStore(
    subscribeRef.current,
    () => connKey,
    () => connKey,
  );

  // Demuxer: feeds incoming chunks into the *current* readUIMessageStream
  // sub-stream. Boundaries are `{type: "finish"}` chunks — except when the
  // backend purges JetStream before the publish lands (requires_action +
  // tool-calls finishReason race), in which case the finish chunk never
  // reaches the client. We also listen to the `decopilot.finish` SSE event
  // and force-close the sub-stream there as a backstop.
  const demuxRef = useRef<{
    subController: ReadableStreamDefaultController<UIMessageChunk> | null;
    /**
     * `readUIMessageStream` folds chunks into a UIMessage but drops the
     * top-level `finishReason` field on the `{type: "finish"}` chunk —
     * the message snapshot it yields has `parts` / `metadata` but no
     * finishReason. We capture it from the raw chunk here and forward it
     * through `onFinish` so the consumer's warning-banner logic
     * (`finishReason !== "stop"`) keeps working.
     */
    pendingFinishReason: string | undefined;
    /**
     * When true, the next sub-stream close should *not* push its partial
     * message into `localMessages` or fire `onFinish`. Set by tear-down
     * paths (reconnect, thread switch) where the chunks they've folded
     * so far will be re-delivered by the upcoming new connection — so
     * keeping the partial would duplicate the run once replay finishes.
     */
    discardOnClose: boolean;
    /**
     * `(SSE decopilot.finish events) - (AI-SDK {type:"finish"} chunks
     * observed)`. Positive means the watch SSE is ahead and the chunk
     * still hasn't landed — the only condition under which the backstop
     * should fire. Without this, the 1.5s timer would happily close the
     * NEXT run's sub-stream if it had started in the meantime (via user
     * send or `maybeAutoSend` after tool output / approval response).
     */
    pendingSseBackstops: number;
    consume: () => Promise<void>;
  }>({
    subController: null,
    pendingFinishReason: undefined,
    discardOnClose: false,
    pendingSseBackstops: 0,
    consume: async () => {},
  });

  const forceCloseCurrentSubStream = (discard = false): void => {
    const ctrl = demuxRef.current.subController;
    if (!ctrl) return;
    demuxRef.current.discardOnClose = discard;
    demuxRef.current.subController = null;
    try {
      ctrl.close();
    } catch {
      // Already closed — readUIMessageStream's own finally will handle the
      // promotion to localMessages.
    }
  };

  // SSE `decopilot.finish` is the *backstop* for the rare case where the
  // backend purges JetStream before the AI-SDK `{type: "finish"}` chunk
  // lands and the demux's sub-stream would otherwise hang.
  //
  // It's a noisy signal — the watch SSE and the JetStream tail are
  // independent transports, so the SSE event for run N can arrive after
  // run N's chunk-finish (and after run N+1 has started!). The counter
  // `pendingSseBackstops` deduplicates: every chunk-finish decrements,
  // every SSE finish increments, and we only schedule / fire the timer
  // when the counter is positive (i.e., an SSE event has no matching
  // chunk yet). Without this, the timer would close the wrong sub when
  // the user — or `maybeAutoSend` — kicks off a follow-up run inside the
  // backstop window, fragmenting the new run's assistant message.
  const SSE_FINISH_BACKSTOP_MS = 1500;
  useDecopilotEvents({
    orgSlug,
    taskId: threadId,
    onFinish: () => {
      demuxRef.current.pendingSseBackstops++;
      if (demuxRef.current.pendingSseBackstops <= 0) return;
      setTimeout(() => {
        if (demuxRef.current.pendingSseBackstops <= 0) return;
        demuxRef.current.pendingSseBackstops--;
        forceCloseCurrentSubStream();
      }, SSE_FINISH_BACKSTOP_MS);
    },
  });

  function ensureSubStream(): ReadableStreamDefaultController<UIMessageChunk> {
    if (demuxRef.current.subController) return demuxRef.current.subController;
    demuxRef.current.pendingFinishReason = undefined;
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
      // Sub-stream closed — either the finish chunk landed, the SSE
      // backstop fired, or a reconnect path tore it down. The
      // `discardOnClose` flag distinguishes the third case: the chunks
      // we already folded will be re-delivered when the next /attach
      // replays from JetStream's start, so we drop the partial here
      // instead of half-committing it to localMessages.
      const finishReason = demuxRef.current.pendingFinishReason;
      const discard = demuxRef.current.discardOnClose;
      demuxRef.current.subController = null;
      demuxRef.current.pendingFinishReason = undefined;
      demuxRef.current.discardOnClose = false;
      const finalMsg = last;
      if (finalMsg && !discard) {
        localMessagesStore.current.update((prev) => [...prev, finalMsg]);
        streamingStore.current.set(null);
      }
      if (!discard) {
        statusStore.current.set("ready");
      }
      if (finalMsg && !discard) {
        cbRef.current.onFinish?.({
          message: finalMsg,
          messages: snapshotAll(),
          finishReason,
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
        toolCall: {
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        },
      });
    }

    const sub = ensureSubStream();
    sub.enqueue(chunk);
    if (chunk.type === "finish") {
      const finishChunk = chunk as { type: "finish"; finishReason?: string };
      demuxRef.current.pendingFinishReason = finishChunk.finishReason;
      // Pair this chunk-finish with any not-yet-matched SSE finish so a
      // pending backstop timer (or any future SSE finish for an
      // already-completed run) won't close the wrong sub-stream.
      demuxRef.current.pendingSseBackstops--;
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
    // The assistant we need to patch can live in either store:
    //   - localMessages: if it was produced by this tab's stream
    //   - initialMessages (server snapshot): if the user opened/refreshed
    //     the thread while a `requires_action` was already pending, or
    //     navigated back to it after the persistent attach replayed the
    //     state into the DB but not yet into our local store
    // For the second case, promote a patched copy into localMessages so
    // mergeWithServer (local wins) renders the patched version and the
    // continuation POST body carries the user's tool output.
    const localPrev = localMessagesStore.current.get();
    const lastIdx = localPrev.length - 1;
    const localLast = lastIdx >= 0 ? localPrev[lastIdx] : undefined;
    if (localLast && localLast.role === "assistant") {
      const next = [...localPrev];
      next[lastIdx] = {
        ...localLast,
        parts: update(localLast.parts),
      } as Tagged<UI_MESSAGE>;
      localMessagesStore.current.set(next);
      return;
    }
    const serverLastIdx = initialMessages.length - 1;
    const serverLast =
      serverLastIdx >= 0 ? initialMessages[serverLastIdx] : undefined;
    if (serverLast && serverLast.role === "assistant") {
      const patched = {
        ...serverLast,
        parts: update(serverLast.parts),
      } as Tagged<UI_MESSAGE>;
      localMessagesStore.current.set([...localPrev, patched]);
    }
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
 * Compose a "current view" of messages from the server snapshot plus
 * local extras (optimistic user messages, completed assistant messages,
 * and any in-place patches from addToolOutput / addToolApprovalResponse
 * that haven't round-tripped through the backend yet).
 *
 * When local and server share an id, *local wins* — local is always the
 * more-recent version because we patch it eagerly on tool output /
 * approval response, and we'd otherwise show the stale server copy until
 * the next refetch (and worse: feed the stale copy back into the
 * continuation POST body, so the backend would never see the user's
 * approval and the run would never continue).
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

/**
 * Persistent /attach with automatic reconnect on transient failures.
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
async function runPersistentLoop(args: {
  url: string;
  signal: AbortSignal;
  onChunk: (chunk: UIMessageChunk) => void;
  onError: (err: Error) => void;
  /** Called once before each reconnect attempt (after the first). */
  onReconnect?: () => void;
}): Promise<void> {
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
}
