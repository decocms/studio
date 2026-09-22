/**
 * `useClockTick` — subscribe to a coarse wall-clock heartbeat.
 *
 * Returns the wall-clock time as of the latest tick, refreshed every
 * `intervalMs` (default 60s), so any component that calls this hook
 * re-renders on the same cadence. Use it to keep relative timestamps
 * (`formatTimeAgo`) fresh on rows whose `task` props haven't changed and
 * would otherwise stay memoized by the React compiler.
 *
 * Returning the timestamp — rather than a bare counter the caller pairs with
 * its own `Date.now()` — is what keeps consumers pure. Reading the clock
 * during render makes a component's output depend on when it rendered, which
 * React Compiler rejects (`react/purity`) because it may re-run render at any
 * time. Here the clock is read inside the store on a tick, and `getSnapshot`
 * only reads back a cached field, so it is stable between ticks (returning a
 * fresh `Date.now()` from `getSnapshot` would loop `useSyncExternalStore`
 * forever).
 *
 * Singleton timer per interval: every subscriber to the same `intervalMs`
 * shares one `setInterval` and one counter. Timer starts on the first
 * subscriber and stops when the last unsubscribes — no leaked timers
 * after the component tree unmounts.
 */

import { useSyncExternalStore } from "react";

interface TickStore {
  /** Wall-clock time sampled at the last tick. Never read during render. */
  now: number;
  subscribers: Set<() => void>;
  intervalId: ReturnType<typeof setInterval> | null;
}

const stores = new Map<number, TickStore>();

function getStore(intervalMs: number): TickStore {
  let store = stores.get(intervalMs);
  if (!store) {
    store = { now: Date.now(), subscribers: new Set(), intervalId: null };
    stores.set(intervalMs, store);
  }
  return store;
}

function subscribe(intervalMs: number, listener: () => void): () => void {
  const store = getStore(intervalMs);
  store.subscribers.add(listener);
  if (store.intervalId === null) {
    store.intervalId = setInterval(() => {
      store.now = Date.now();
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

/** Wall-clock ms as of the most recent tick. Changes every `intervalMs`. */
export function useClockTick(intervalMs: number = 60_000): number {
  const read = () => getStore(intervalMs).now;
  return useSyncExternalStore(
    (listener) => subscribe(intervalMs, listener),
    read,
    read,
  );
}
