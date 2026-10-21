/**
 * Per-API-key request ceiling, counted in process.
 *
 * better-auth's own api-key limiter stays off (`auth/index.ts`): it only
 * resets a window once a key has been idle for the whole window, so a key
 * with steady traffic stays blocked forever, and it rewrites the key row on
 * every request without coordination. Existing keys also store
 * `rateLimitEnabled: false`, so turning it on would not cover them anyway.
 *
 * This limiter is a fixed window per key id. The count lives in each pod, so
 * the effective ceiling is `limit × replicas` — a guard against a runaway or
 * leaked key, not exact accounting.
 */

import type { Counter } from "@opentelemetry/api";
import { meter } from "../observability";

export type ApiKeyRateLimitMode = "off" | "observe" | "enforce";

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  /** Seconds until the key's window restarts; set only when over the limit. */
  retryAfterSeconds?: number;
}

interface Window {
  startedAt: number;
  count: number;
}

export interface ApiKeyRateLimiterOptions {
  mode: Exclude<ApiKeyRateLimitMode, "off">;
  limit: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
  /** Called once per key per window, on the first request over the limit. */
  onExceeded?: (keyId: string) => void;
}

export function createApiKeyRateLimiter({
  mode,
  limit,
  windowMs,
  maxEntries = 50_000,
  now = Date.now,
  onExceeded,
}: ApiKeyRateLimiterOptions) {
  const windows = new Map<string, Window>();

  function evict(at: number) {
    // Windows are re-inserted when they restart, so the Map stays ordered by start time.
    for (const [keyId, window] of windows) {
      if (at - window.startedAt < windowMs && windows.size < maxEntries) break;
      windows.delete(keyId);
    }
  }

  function hit(keyId: string): ApiKeyRateLimitResult {
    const at = now();
    let window = windows.get(keyId);
    if (!window || at - window.startedAt >= windowMs) {
      windows.delete(keyId);
      evict(at);
      window = { startedAt: at, count: 0 };
      windows.set(keyId, window);
    }

    window.count += 1;
    if (window.count <= limit) return { allowed: true };

    if (window.count === limit + 1) onExceeded?.(keyId);
    if (mode === "observe") return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.startedAt + windowMs - at) / 1000),
      ),
    };
  }

  return { hit, size: () => windows.size };
}

let exceededCounter: Counter | undefined;

export function reportApiKeyRateLimitExceeded(
  keyId: string,
  mode: ApiKeyRateLimitMode,
) {
  exceededCounter ??= meter.createCounter("api_key_rate_limit_exceeded", {
    description: "API keys that went over their per-minute request ceiling",
    unit: "{windows}",
  });
  exceededCounter.add(1, { mode });
  console.warn("[Auth] API key over rate limit", { keyId, mode });
}
