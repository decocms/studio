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
export const PREVIEW_STRIP_REQUEST_HEADERS = [
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
export const PREVIEW_STRIP_RESPONSE_HEADERS = [
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
export function previewJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
