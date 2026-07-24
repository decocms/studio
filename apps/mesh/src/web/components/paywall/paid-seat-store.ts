/**
 * Tiny external store driving the paid-seat paywall dialog.
 *
 * A module-level store (rather than React state) is what lets the
 * QueryClient's global `MutationCache.onError` — which runs outside any
 * component — open the paywall when a mutation fails with a
 * `[PAID_SEAT_REQUIRED]` error. The single root-mounted `PaidSeatPaywallHost`
 * subscribes via `useSyncExternalStore` and renders the dialog.
 *
 * The chat surface does NOT use this store: chat streaming errors flow through
 * `useChatStream()` (not react-query), so the chat highlight stack renders the
 * dialog inline instead — see components/chat/highlight.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openPaidSeatPaywall(): void {
  if (open) return;
  open = true;
  emit();
}

export function closePaidSeatPaywall(): void {
  if (!open) return;
  open = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return open;
}

/** Reactive read of whether the paywall dialog should be open. */
export function usePaidSeatPaywallOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
