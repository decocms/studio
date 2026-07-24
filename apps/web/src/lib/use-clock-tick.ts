/**
 * `useClockTick` — subscribe to a coarse wall-clock heartbeat.
 *
 * Returns a number that increments every `intervalMs` (default 60s), so
 * any component that calls this hook re-renders on the same cadence.
 * Use it to keep relative timestamps (`formatTimeAgo`) fresh on rows
 * whose `task` props haven't changed and would otherwise stay memoized
 * by the React compiler.
 *
 * Singleton timer per interval: every subscriber to the same `intervalMs`
 * shares one `setInterval` and one counter. Timer starts on the first
 * subscriber and stops when the last unsubscribes — no leaked timers
 * after the component tree unmounts.
 */

import { useSyncExternalStore } from "react";

interface TickStore {
  tick: number;
  subscribers: Set<() => void>;
  intervalId: ReturnType<typeof setInterval> | null;
}

const stores = new Map<number, TickStore>();

function getStore(intervalMs: number): TickStore {
  let store = stores.get(intervalMs);
  if (!store) {
    store = { tick: 0, subscribers: new Set(), intervalId: null };
    stores.set(intervalMs, store);
  }
  return store;
}

function subscribe(intervalMs: number, listener: () => void): () => void {
  const store = getStore(intervalMs);
  store.subscribers.add(listener);
  if (store.intervalId === null) {
    store.intervalId = setInterval(() => {
      store.tick += 1;
      for (const s of store.subscribers) s();
    }, intervalMs);
  }
  return () => {
    store.subscribers.delete(listener);
    if (store.subscribers.size === 0 && store.intervalId !== null) {
      clearInterval(store.intervalId);
      store.intervalId = null;
    }
  };
}

export function useClockTick(intervalMs: number = 60_000): number {
  return useSyncExternalStore(
    (listener) => subscribe(intervalMs, listener),
    () => getStore(intervalMs).tick,
    () => 0,
  );
}
