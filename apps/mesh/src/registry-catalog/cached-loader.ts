/**
 * Single-value cached loader with single-flight + stale-while-revalidate +
 * fail-soft, mirroring the `mcp-list-cache.ts` discipline.
 *
 * - **Single-flight:** concurrent callers share one in-flight load.
 * - **Stale-while-revalidate:** past the TTL, the cached value is returned
 *   immediately while a background refresh runs; a failed refresh keeps the
 *   last-good value.
 * - **Cold start:** the first caller awaits the load (retried). If it
 *   ultimately fails, `get()` rejects — the caller (the catalog aggregator)
 *   treats that source as empty so one bad source can't sink the others.
 *
 * `now` is injectable so TTL behavior is unit-testable without sleeping.
 */

import { retry } from "@decocms/std";

export interface CachedLoaderOptions<T> {
  load: (signal?: AbortSignal) => Promise<T>;
  ttlMs: number;
  /** Retry attempts per load (transient fetch failures). Default 3. */
  maxAttempts?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

export interface CachedLoader<T> {
  /** Fresh value, or stale value while a background refresh runs. */
  get(): Promise<T>;
  /** Eager load (boot warm-up); fail-soft — never throws. */
  warm(): Promise<void>;
}

export function createCachedLoader<T>(
  opts: CachedLoaderOptions<T>,
): CachedLoader<T> {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 3;

  let state: { value: T; loadedAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    // Single-flight: collapse concurrent loads onto one promise.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await retry(() => opts.load(), {
          maxAttempts,
          minTimeout: 500,
          maxTimeout: 5_000,
        });
        state = { value, loadedAt: now() };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async get(): Promise<T> {
      if (state) {
        if (now() - state.loadedAt >= opts.ttlMs) {
          // Stale: refresh in the background, keep serving the last-good value.
          // A failed refresh is swallowed so we never drop to empty mid-life.
          void refresh().catch(() => {});
        }
        return state.value;
      }
      // Cold: await (single-flight). May reject → caller treats source as empty.
      return refresh();
    },

    async warm(): Promise<void> {
      try {
        await refresh();
      } catch {
        // Fail-soft: leave the cache empty; the next get() will retry.
      }
    },
  };
}
