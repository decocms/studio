import { jsonResponse } from "./routes/body-parser";

/**
 * Bearer-token auth for the daemon's `/_sandbox/*` routes.
 *
 * The daemon only ever receives requests over a trusted transport, so a
 * shared bearer token is the whole auth story:
 *   - desktop link: loopback from the link daemon's control handler, which
 *     injects `Authorization: Bearer <daemonToken>` after the cluster
 *     reached the link daemon over an authenticated WebSocket;
 *   - in-cluster docker: loopback from decopilot's built-in tools with the
 *     same per-spawn bearer token.
 *
 * (A prior HMAC request-signing scheme protected the old untrusted
 * Cloudflare tunnel; that transport was replaced by the WS+NATS link in
 * commit 998fefd33, leaving the HMAC path with no signer — it has been
 * removed.)
 *
 * Returns null on success; an unauthorized Response on failure.
 */
export function requireToken(
  req: Request,
  expectedToken: string,
): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const provided = header.slice(prefix.length);
  // An empty expected token must never match — a daemon spawned without a
  // token rejects everything rather than accepting a blank `Bearer `.
  if (!expectedToken || !constantTimeEqual(provided, expectedToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
