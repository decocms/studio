/**
 * useChatThread — thin React selector over the thread stream registry.
 *
 * The persistent /stream SSE, folded message stores, demuxer, and mutators
 * all live on a single ThreadConnection instance owned by the registry.
 * This hook just:
 *   - resolves the connection via getOrOpenStream (idempotent for same key)
 *   - mirrors per-render context onto the connection
 *   - registers itself as the connection's single observer
 *   - reads the connection's stores via useSyncExternalStore
 *   - returns mutator delegates bound to the connection
 */

// oxlint-disable ban-use-effect/ban-use-effect — the observer slot is per-mount and useEffect is the natural fit; the alternative (useSyncExternalStore + noop snapshot) is more code for the same effect

import { type UIMessage, type UIMessageChunk } from "ai";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getOrOpenStream,
  type ChatStreamStatus,
  type RequestOptions,
  type Store,
  type ThreadObserver,
} from "./thread-stream-registry";
import { useTaskMessages } from "../task/use-task-messages";

export type { ChatStreamStatus, RequestOptions };

export interface UseChatStreamOptions<UI_MESSAGE extends UIMessage> {
  threadId: string;
  orgSlug: string;
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
   * Shape matches useChat's `ChatOnToolCallCallback` — `{ toolCall: {...} }` —
   * so existing handlers like `useInvalidateCollectionsOnToolCall` keep
   * working unchanged.
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
  sendMessage: (message: UI_MESSAGE, opts: RequestOptions) => Promise<void>;
  stop: () => void;
  setMessages: (
    updater: UI_MESSAGE[] | ((prev: UI_MESSAGE[]) => UI_MESSAGE[]),
  ) => void;
  addToolOutput: (
    args: {
      toolCallId: string;
      output?: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
    },
    opts: RequestOptions,
  ) => void;
  addToolApprovalResponse: (
    args: { id: string; approved: boolean; reason?: string },
    opts: RequestOptions,
  ) => void;
  clearError: () => void;
}

function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

export function useChatThread<UI_MESSAGE extends UIMessage>(
  opts: UseChatStreamOptions<UI_MESSAGE>,
): UseChatStreamResult<UI_MESSAGE> {
  const conn = getOrOpenStream(opts.orgSlug, opts.threadId);

  // Pull the server snapshot from the DB-backed THREAD_MESSAGES cache.
  // Previously the consumer (chat-context) did this and passed the
  // result as `initialMessages`; now it lives inside the hook so the
  // public API is just `{ threadId, orgSlug, ...callbacks }`.
  const initialMessages = useTaskMessages(opts.threadId);

  // Mirror per-render context onto the connection so mutators (which
  // run later, on user events) read the latest props at call time.
  conn.context = {
    initialMessages: initialMessages as UIMessage[],
  };

  // Stable callback ref so the observer wrapper sees the latest consumer
  // callbacks without re-running the effect.
  const cbRef = useRef(opts);
  cbRef.current = opts;

  useEffect(() => {
    const observer: ThreadObserver = {
      onData: (chunk) => cbRef.current.onData?.(chunk),
      onToolCall: (event) => cbRef.current.onToolCall?.(event),
      onFinish: (msg, messages, finishReason) => {
        cbRef.current.onFinish?.({
          message: msg as UI_MESSAGE,
          messages: messages as UI_MESSAGE[],
          finishReason,
          isAbort: false,
          isDisconnect: false,
          isError: false,
        });
      },
      onError: (err) => cbRef.current.onError?.(err),
    };
    conn.observer = observer;
    return () => {
      if (conn.observer === observer) conn.observer = null;
    };
  }, [conn]);

  // Subscribe to each store; the snapshotAll computation in the return
  // value re-runs whenever any of these change.
  useStore(conn.localMessages);
  useStore(conn.streaming);
  const status = useStore(conn.status);
  const error = useStore(conn.error);

  return {
    messages: conn.snapshotAll() as UI_MESSAGE[],
    status,
    error,
    sendMessage: (message, reqOpts) => conn.sendMessage(message, reqOpts),
    stop: () => conn.stop(),
    setMessages: (updater) =>
      conn.setMessages(
        updater as UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
      ),
    addToolOutput: (args, reqOpts) => conn.addToolOutput(args, reqOpts),
    addToolApprovalResponse: (args, reqOpts) =>
      conn.addToolApprovalResponse(args, reqOpts),
    clearError: () => conn.clearError(),
  };
}
