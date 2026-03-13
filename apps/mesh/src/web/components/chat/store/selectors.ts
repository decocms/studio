/**
 * useChatStore — selector-based hook for subscribing to ChatStore slices.
 *
 * Uses useSyncExternalStore so React only re-renders when the selected
 * slice actually changes (reference equality by default).
 */

import { useSyncExternalStore } from "react";
import { chatStore } from "./chat-store";
import type { ChatStoreState } from "./types";

// ============================================================================
// Core selector hook
// ============================================================================

export function useChatStore<T>(selector: (s: ChatStoreState) => T): T {
  return useSyncExternalStore(
    chatStore.subscribe,
    () => selector(chatStore.getSnapshot()),
    () => selector(chatStore.getSnapshot()),
  );
}

// ============================================================================
// Convenience hooks
// ============================================================================

export const useChatMessages = () =>
  useChatStore((s) => s.threadMessages[s.activeThreadId] ?? []);

export const useActiveThreadId = () => useChatStore((s) => s.activeThreadId);
