/**
 * useThreadChat — thin React wrapper over ThreadChatStore.
 *
 * The hook owns the React-level concerns (lifecycle, snapshot subscription,
 * merging with the `initialMessages` prop) and delegates every imperative
 * concern (SSE, demux, demuxer backstop, optimistic local buffer) to the
 * store. See `thread-chat-store.ts` for the protocol and concurrency notes.
 */

import type {
  ChatAddToolApproveResponseFunction,
  ChatAddToolOutputFunction,
  UIMessage,
} from "ai";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import {
  type ChatStreamStatus,
  mergeWithServer,
  type ThreadChatHandlers,
  ThreadChatStore,
} from "./thread-chat-store";

export type { ChatStreamStatus };

export interface UseChatStreamOptions<M extends UIMessage>
  extends ThreadChatHandlers<M> {
  threadId: string;
  orgSlug: string;
  initialMessages: M[];
}

export interface UseChatStreamResult<M extends UIMessage> {
  messages: M[];
  status: ChatStreamStatus;
  error: Error | null;
  sendMessage: (message: M, opts?: { metadata?: unknown }) => Promise<void>;
  stop: () => void;
  setMessages: (updater: M[] | ((prev: M[]) => M[])) => void;
  addToolOutput: ChatAddToolOutputFunction<M>;
  addToolApprovalResponse: ChatAddToolApproveResponseFunction;
  clearError: () => void;
}

export function useThreadChat<M extends UIMessage>(
  opts: UseChatStreamOptions<M>,
): UseChatStreamResult<M> {
  const { threadId, orgSlug, initialMessages, ...handlers } = opts;

  // Latest-handlers ref — canonical pattern for "read latest closures
  // from a long-lived external object". React permits ref writes during
  // render for refs holding values used during render.
  const handlersRef = useRef<ThreadChatHandlers<M>>(handlers);
  handlersRef.current = handlers;

  // Live read of the server snapshot — the store uses this as a fallback
  // in patchLastAssistant when the thread is opened mid-`requires_action`
  // (assistant exists only in the server snapshot, not yet in local).
  const initialMessagesRef = useRef<UIMessage[]>(initialMessages);
  initialMessagesRef.current = initialMessages;

  const [store] = useState(
    () => new ThreadChatStore<M>({ handlersRef, initialMessagesRef }),
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    store.connect({ orgSlug, threadId });
    return () => store.disconnect();
  }, [store, orgSlug, threadId]);

  useDecopilotEvents({
    orgSlug,
    taskId: threadId,
    onFinish: () => store.notifySseFinish(),
  });

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Merge with `initialMessages` happens in React because it's a prop
  // (typically driven by React Query); the store stays prop-agnostic.
  const composed = mergeWithServer(initialMessages, snap.local);
  // Streaming can share an id with an entry in `composed` — this happens
  // during continuation runs, where the backend resumes the same assistant
  // message id after a tool output / approval response. Replace the
  // matching entry in place so React keys stay unique; only append when
  // there's no match (the normal "new assistant" case).
  let messages: M[];
  if (snap.streaming) {
    const streamingId = snap.streaming.id;
    const idx = composed.findIndex((m) => m.id === streamingId);
    messages =
      idx >= 0
        ? [...composed.slice(0, idx), snap.streaming, ...composed.slice(idx + 1)]
        : [...composed, snap.streaming];
  } else {
    messages = composed;
  }

  return {
    messages,
    status: snap.status,
    error: snap.error,
    sendMessage: store.sendMessage.bind(store),
    stop: store.stop.bind(store),
    setMessages: (updater) => store.setMessages(initialMessages, updater),
    addToolOutput: store.addToolOutput,
    addToolApprovalResponse: store.addToolApprovalResponse,
    clearError: () => store.clearError(),
  };
}
