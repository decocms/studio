import { retry } from "@decocms/std";

/** Max size of an offloaded messages blob (bound to a realistic harness input,
 *  not a generic 500MiB transfer). */
export const MAX_OFFLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Assert that `raw` is a URL that is safe to fetch for offloaded messages.
 *
 * Guards:
 * - Must be a valid URL (no data: URIs or malformed strings)
 * - Must use https: unless `allowSameHostDev` is true and the host is loopback
 * - Host must be in the `allowedHosts` allowlist (comes from daemon config,
 *   NEVER from the request frame — that is the SSRF guarantee)
 *
 * Returns the parsed URL on success; throws with a descriptive message on
 * any violation.
 */
export function assertAllowedRefUrl(
  raw: string,
  allowedHosts: string[],
  allowSameHostDev: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("offload ref: malformed URL");
  }

  const isHttps = url.protocol === "https:";
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";

  if (allowSameHostDev && url.protocol === "http:" && isLoopback) {
    // dev: same-host MinIO over loopback is allowed.
  } else if (!isHttps) {
    throw new Error("offload ref: only https is allowed");
  }

  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`offload ref: host not allowed (${url.hostname})`);
  }

  return url;
}

/** Fetch the offloaded messages JSON with a deadline, size cap, manual redirect,
 *  and bounded retry. allowedHosts/allowSameHostDev come from daemon config
 *  (NEVER from the request frame; that's the SSRF guarantee). */
export async function fetchOffloadedMessages(
  rawUrl: string,
  opts: {
    allowedHosts: string[];
    allowSameHostDev: boolean;
    deadlineMs?: number;
  },
): Promise<unknown> {
  assertAllowedRefUrl(rawUrl, opts.allowedHosts, opts.allowSameHostDev);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.deadlineMs ?? 30_000);

  try {
    const res = await retry(
      async () => {
        const r = await fetch(rawUrl, {
          redirect: "manual",
          signal: ac.signal,
        });
        if (!r.ok) {
          const err = new Error(`offload fetch ${r.status}`);
          (err as { status?: number }).status = r.status;
          throw err;
        }
        return r;
      },
      {
        maxAttempts: 3,
        minTimeout: 200,
        maxTimeout: 5_000,
        isRetriable: (e) => {
          const s = (e as { status?: number }).status;
          // Retry on network errors (no status) and 5xx; not on 4xx
          return s === undefined || s >= 500;
        },
      },
    );

    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_OFFLOAD_BYTES) throw new Error("offload ref: too large");

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_OFFLOAD_BYTES)
      throw new Error("offload ref: too large");

    return JSON.parse(new TextDecoder().decode(buf));
  } finally {
    clearTimeout(timer);
  }
}
