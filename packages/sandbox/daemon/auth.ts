import {
  SIG_HEADER,
  verifyRequest,
} from "../../../apps/mesh/src/links/protocol/hmac";
import { jsonResponse } from "./routes/body-parser";

function requireToken(req: Request, expectedToken: string): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const provided = header.slice(prefix.length);
  if (!constantTimeEqual(provided, expectedToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

export interface HmacOrTokenDeps {
  // HMAC signing key — equals the cluster-side `LinkEntry.linkSecret`.
  // May be empty for daemons that aren't running under a link (legacy docker).
  linkSecret: string;
  // Bearer token — the legacy auth path. Both env-spawned daemons set this.
  daemonToken: string;
  // Nonce-replay guard. The caller owns sizing/TTL — verifier just queries.
  seenNonce: (nonce: string) => boolean;
}

// Accepts EITHER an HMAC-signed request (cluster → daemon over the link's
// tunnel) OR a bearer-token request (in-cluster decopilot built-in tools
// spawning docker). HMAC is checked first when its headers are present —
// a malformed HMAC is a hard reject (no silent downgrade to bearer). When
// HMAC headers are absent, falls through to bearer.
//
// Why no silent downgrade: a signature-present-but-invalid request is an
// attack signal, not a hint to retry with another scheme. Allowing bearer
// to succeed when HMAC fails would let an attacker probing the link's
// secret discover that bearer is also accepted, leaking the per-endpoint
// capability set to an unauthenticated probe. Treat the signature-present
// branch as committed: it succeeds or rejects on its own merit.
//
// Returns null on success; an unauthorized Response on failure.
export function requireHmacOrToken(
  req: Request,
  path: string,
  body: string,
  deps: HmacOrTokenDeps,
): Response | null {
  const headers = Object.fromEntries(req.headers);
  const hasSignature = !!(
    headers[SIG_HEADER] ?? headers[SIG_HEADER.toLowerCase()]
  );
  if (hasSignature) {
    if (!deps.linkSecret) {
      return jsonResponse({ error: "unauthorized", reason: "no_link" }, 401);
    }
    const result = verifyRequest({
      secret: deps.linkSecret,
      method: req.method,
      path,
      body,
      headers,
      seenNonce: deps.seenNonce,
    });
    if (!result.valid) {
      return jsonResponse(
        { error: "unauthorized", reason: result.reason },
        401,
      );
    }
    return null;
  }
  return requireToken(req, deps.daemonToken);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
