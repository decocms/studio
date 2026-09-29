/**
 * Response-header marker on the preview-proxy's "sandbox not ready" envelopes
 * (404 "sandbox not found" in dev, 502 "sandbox daemon unreachable" in prod).
 * The Studio edge (`apps/api/src/sandbox/preview-proxy.ts`) swaps these for an
 * auto-reloading "connecting" page on top-level document navigations.
 */
export const PREVIEW_NOT_READY_HEADER = "x-sandbox-preview-not-ready";

/**
 * Headers stripped before re-issuing the preview proxy fetch. Hop-by-hop per
 * RFC 7230 + cookies (preview is per-handle, not per-user — no callee session
 * leak) + accept-encoding (Bun fetch auto-decompresses, so a downstream
 * content-encoding would mismatch the actual body).
 */
const PREVIEW_STRIP_REQUEST_HEADERS = [
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "accept-encoding",
  "content-length",
  "upgrade",
];

/**
 * Stripped from the proxied response. content-encoding/length would mismatch
 * after Bun fetch auto-decompresses; CSP/X-Frame-Options the daemon already
 * rewrote — re-passing them defeats the iframe-embedding fix the daemon
 * installed.
 */
const PREVIEW_STRIP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
];

// CORS headers on synthesized preview-proxy responses. The studio iframe
// renders under the studio origin and fetches the preview origin cross-site
// (SSE at `/_sandbox/events`, plus the EventSource probeMissing fetch);
// without ACAO the browser blocks the response *and* hides the actual status,
// so a 404 from us looks like an opaque CORS failure in devtools. The daemon
// already sets ACAO on its own responses — these headers only fire on errors
// we synthesize before reaching the daemon.
function previewJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function withoutStrippedHeaders(upstream: Response): Response {
  const headers = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!PREVIEW_STRIP_RESPONSE_HEADERS.includes(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function notReady(status: 404 | 502, error: string): Response {
  const res = previewJsonResponse(status, { error });
  res.headers.set(PREVIEW_NOT_READY_HEADER, "1");
  return res;
}

/**
 * Reverse-proxies an inbound preview request to a sandbox's daemon.
 * Unauthenticated by design — preview URLs are open the same way Vercel
 * preview URLs are; the *handle* is the secret.
 *
 * `/_sandbox/*` access policy at the edge:
 *   - **GET** is allowed through. The daemon's `/events` SSE and `/scripts`
 *     are intentionally unauthenticated and CORS-enabled (`Allow-Origin: *`)
 *     because the studio UI consumes them cross-origin from the preview
 *     URL — that's the only path it has to live setup state.
 *   - **Non-GET** is rejected as defense-in-depth. The daemon enforces bearer
 *     auth on the mutating endpoints, but the only legitimate caller for those
 *     is studio itself; the preview surface should never see them.
 *
 * A failed fetch usually means the address went stale (the operator evicted
 * the claim on idle TTL): `invalidate` drops it, and a replay-safe request
 * retries once at `retryBase`. A POST's body stream is consumed by the failed
 * fetch, so replaying it would send it empty; the caller retries after the 502.
 */
export async function proxyPreview(
  request: Request,
  upstream: {
    base(): Promise<string | null>;
    invalidate(): void;
    retryBase(): Promise<string | null>;
  },
  logLabel: string,
): Promise<Response> {
  const upstreamBase = await upstream.base();
  if (!upstreamBase) return notReady(404, "sandbox not found");

  const reqUrl = new URL(request.url);
  const isAdminPath =
    reqUrl.pathname === "/_sandbox" || reqUrl.pathname.startsWith("/_sandbox/");
  if (isAdminPath && request.method !== "GET") {
    return previewJsonResponse(404, { error: "not found" });
  }

  const target = (base: string) => `${base}${reqUrl.pathname}${reqUrl.search}`;
  const headers = new Headers(request.headers);
  for (const h of PREVIEW_STRIP_REQUEST_HEADERS) headers.delete(h);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    signal: request.signal,
    duplex: hasBody ? "half" : undefined,
  };

  try {
    return withoutStrippedHeaders(
      await fetch(target(upstreamBase), init as RequestInit),
    );
  } catch (err) {
    // Host + pathname only: query strings can carry secrets (magic-link
    // tokens, signed URLs) and would otherwise end up in the logs.
    const safeTarget = `${upstreamBase}${reqUrl.pathname}`;
    console.warn(
      `[${logLabel}] preview fetch to ${safeTarget} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    upstream.invalidate();
    if (request.method === "GET" || request.method === "HEAD") {
      const retryBase = await upstream.retryBase();
      if (retryBase) {
        try {
          return withoutStrippedHeaders(
            await fetch(target(retryBase), init as RequestInit),
          );
        } catch (retryErr) {
          console.warn(
            `[${logLabel}] preview fetch retry to ${safeTarget} failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
        }
      }
    }
    return notReady(502, "sandbox daemon unreachable");
  }
}
