/**
 * Per-key in-flight promise dedup (single-flight).
 *
 * Concurrent `run(key, fn)` calls for the same key while a flight is pending
 * share ONE promise; the entry is removed when it settles (resolve or reject),
 * so failures are never cached — the next caller re-runs. Same pattern as the
 * inline `inflight` maps in `oauth/github-mint.ts` and
 * `mcp-clients/outbound/client-pool.ts`, factored out for the decofile disk
 * cache (spec: disk-cache-spec.md §Cold read).
 */
export function createSingleFlight<T>(): {
  run: (key: string, fn: () => Promise<T>) => Promise<T>;
} {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inflight.get(key);
      if (existing) return existing;
      // Promise.resolve().then(fn) normalizes a synchronous throw in `fn`
      // into a rejection so it still propagates to every waiter and the
      // entry is still cleaned up.
      const p = Promise.resolve()
        .then(fn)
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
  };
}
