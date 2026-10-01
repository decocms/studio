import type { Context } from "hono";

/**
 * Best-effort client IP for per-IP limits. cf-connecting-ip is set by
 * Cloudflare and not client-spoofable behind it; x-real-ip by many reverse
 * proxies. The leftmost x-forwarded-for is client-supplied (spoofable) — last
 * resort only, which is why per-IP limits need a per-tenant backstop.
 */
export function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Per-pod fixed-window counter: `hit(key)` counts one attempt and returns
 * whether it is within `max` for the current window. The map is capped at
 * `maxKeys`; expired windows are swept first, then the oldest key is evicted.
 */
export function createWindowLimiter(opts: {
  max: number;
  windowMs: number;
  maxKeys?: number;
}): { hit: (key: string, now?: number) => boolean } {
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, now = Date.now()) {
      let entry = windows.get(key);
      if (!entry || now > entry.resetAt) {
        windows.delete(key);
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (now > v.resetAt) windows.delete(k);
          const oldest = windows.keys().next();
          if (windows.size >= maxKeys && !oldest.done) {
            windows.delete(oldest.value);
          }
        }
        entry = { count: 0, resetAt: now + opts.windowMs };
        windows.set(key, entry);
      }
      entry.count++;
      return entry.count <= opts.max;
    },
  };
}
