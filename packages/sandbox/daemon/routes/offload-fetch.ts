import { sha256Hex } from "@decocms/harness/offload-messages";
import { retry } from "@decocms/shared/std";

/** Max size of an offloaded messages blob (bound to a realistic harness input,
 *  not a generic 500MiB transfer). Module-local — only used by the fetcher
 *  below. */
const MAX_OFFLOAD_BYTES = 32 * 1024 * 1024;

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
    url.hostname === "::1" ||
    url.hostname === "[::1]";

  if (allowSameHostDev && url.protocol === "http:" && isLoopback) {
    // dev: same-host MinIO over loopback is allowed.
  } else if (!isHttps) {
    // rejects non-https schemes (data:, ftp:, etc.)
    throw new Error("offload ref: only https is allowed");
  }

  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`offload ref: host not allowed (${url.hostname})`);
  }

  return url;
}

/** Redirect hops a transfer may take before we give up. */
const MAX_TRANSFER_REDIRECTS = 5;

/**
 * `fetch` that re-runs the allowlist on **every** redirect hop.
 *
 * Validating only the caller's URL is no defense: the default
 * `redirect: "follow"` chases a 3xx wherever it points, so an allowed host that
 * answers `302 → https://169.254.169.254/latest/meta-data/` walks the daemon
 * straight into the cloud metadata endpoint. This mirrors what the Go daemon's
 * `urlallow.Client` does with `CheckRedirect`.
 *
 * `maxRedirects: 0` refuses any 3xx outright — the right setting for a request
 * carrying a one-shot stream body, which could not be replayed to a second URL
 * even if that URL were allowed.
 */
export async function fetchAllowedUrl(
  rawUrl: string,
  init: RequestInit,
  opts: {
    allowedHosts: string[];
    allowSameHostDev: boolean;
    maxRedirects?: number;
  },
): Promise<Response> {
  const max = opts.maxRedirects ?? MAX_TRANSFER_REDIRECTS;
  const assertHop = (raw: string) =>
    assertAllowedRefUrl(
      raw,
      opts.allowedHosts,
      opts.allowSameHostDev,
    ).toString();

  let target = assertHop(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (hop >= max) {
      throw new Error(`offload ref: too many redirects (max ${max})`);
    }
    if (!location) throw new Error("offload ref: redirect with no location");
    // Resolve relative Locations against the hop we just made, then re-gate.
    target = assertHop(new URL(location, target).toString());
  }
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
    expectedSha256?: string;
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
        signal: ac.signal,
        isRetriable: (e) => {
          const s = (e as { status?: number }).status;
          // Retry on network errors (no status) and 5xx; not on 4xx
          return s === undefined || s >= 500;
        },
      },
    );

    // Optimistic pre-check: fail fast when content-length is present and too big.
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_OFFLOAD_BYTES) throw new Error("offload ref: too large");

    // Streaming accumulator: hard size cap enforced WHILE reading so a
    // lying/absent content-length cannot OOM the memory-bounded sandbox.
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OFFLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("offload ref: too large");
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const actual = await sha256Hex(buf);
    if (opts.expectedSha256 && actual !== opts.expectedSha256) {
      throw new Error("offload ref: sha256 mismatch");
    }
    return JSON.parse(new TextDecoder().decode(buf));
  } finally {
    clearTimeout(timer);
  }
}
