/**
 * useChatStore — selector-based hook for subscribing to ChatStore slices.
 *
 * Uses useSyncExternalStore so React only re-renders when the selected
 * slice actually changes (reference equality by default).
 */

import { useRef, useSyncExternalStore } from "react";
import { chatStore } from "./chat-store";
import type { ChatStoreState } from "./types";

// ============================================================================
// Core selector hook
// ============================================================================

/**
 * Subscribe to a slice of the ChatStore. The selector result is cached
 * so that `useSyncExternalStore` sees a stable reference when the
 * selected value hasn't changed (shallow equality for objects/arrays).
 */
export function useChatStore<T>(selector: (s: ChatStoreState) => T): T {
  const cacheRef = useRef<{ value: T; state: ChatStoreState } | null>(null);

  const getSnapshot = (): T => {
    const state = chatStore.getSnapshot();

    // Fast path: same state reference means same result
    if (cacheRef.current && cacheRef.current.state === state) {
      return cacheRef.current.value;
    }

    const next = selector(state);

    // If the previous cached value is shallowly equal, reuse it
    if (cacheRef.current && shallowEqual(cacheRef.current.value, next)) {
      cacheRef.current = { value: cacheRef.current.value, state };
      return cacheRef.current.value;
    }

    cacheRef.current = { value: next, state };
    return next;
  };

  return useSyncExternalStore(chatStore.subscribe, getSnapshot, getSnapshot);
}

// ============================================================================
// Convenience hooks
// ============================================================================

const EMPTY_MESSAGES: never[] = [];

export const useChatMessages = () =>
  useChatStore((s) => s.threadMessages[s.activeThreadId] ?? EMPTY_MESSAGES);

export const useActiveThreadId = () => useChatStore((s) => s.activeThreadId);

// ============================================================================
// Shallow equality (one level deep, handles objects and arrays)
// ============================================================================

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const objB = b as Record<string, unknown>;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], objB[key])
    ) {
      return false;
    }
  }
  return true;
}
