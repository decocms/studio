/**
 * Demo Mode — the chat seam.
 *
 * Supplies a scripted `ChatStreamContextValue` to the REAL chat renderers
 * (`Chat.Messages` → `MessagePair` → `MessageAssistant` → tool-call parts) by
 * providing the same context the live `ActiveTaskProvider` provides. The value
 * is backed by a single track's `Store<DemoChatState>`, so as the Director
 * mutates messages the real components re-render identically to a live stream —
 * no live MCP transport, SSE, or backend involved.
 *
 * One provider per track ⇒ several can be mounted side-by-side for a parallel
 * multi-agent layout.
 */
import { useSyncExternalStore, type PropsWithChildren } from "react";
import {
  DemoChatStreamContext,
  type ChatStreamContextValue,
} from "@/web/components/chat/chat-context";
import type { Store } from "@/web/components/chat/store/store-primitive";
import type { DemoChatState } from "./director-stores";

const noop = () => {};
const asyncNoop = async () => {};

export function DemoChatStreamProvider({
  store,
  children,
}: PropsWithChildren<{ store: Store<DemoChatState> }>) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);

  const value: ChatStreamContextValue = {
    messages: state.messages,
    status: state.status,
    sendMessage: asyncNoop,
    stop: noop,
    submit: asyncNoop,
    error: null,
    clearError: noop,
    finishReason: null,
    clearFinishReason: noop,
    isStreaming: state.status === "streaming" || state.status === "submitted",
    isChatEmpty: state.messages.length === 0,
    isWaitingForApprovals: false,
    isRunInProgress: false,
    runStatusStage: null,
    hasMoreOlder: false,
    isFetchingOlder: false,
    fetchOlderMessages: asyncNoop,
  };

  return (
    <DemoChatStreamContext.Provider value={value}>
      {children}
    </DemoChatStreamContext.Provider>
  );
}
