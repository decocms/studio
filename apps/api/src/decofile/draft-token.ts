/**
 * Signed grant for the unauthenticated decofile read: the production site
 * fetching a draft cannot carry a Studio session, so the `?token=` query in
 * the `__draft` pointer authorizes exactly one (org, virtualMcpId, branch)
 * scope for a bounded time. Same sign/verify shape as
 * `file-storage/share-password.ts` unlock tokens.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSettings } from "../settings";

/** Long enough that an open editor session never sees an expiry (tokens are
 * reissued with every authenticated read/write), short enough that a leaked
 * preview URL goes stale within a working day. */
export const DRAFT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

let signingKey: Buffer | null = null;
function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  let secret: string | undefined;
  try {
    const settings = getSettings();
    secret = settings.studioJwtSecret ?? settings.betterAuthSecret;
  } catch {
    // Settings not initialized (unit tests) — fall back like auth/jwt.ts.
    secret = undefined;
  }
  signingKey = secret ? Buffer.from(secret) : randomBytes(32);
  return signingKey;
}

interface DraftClaims {
  /** org id */ o: string;
  /** virtual MCP id */ m: string;
  /** branch */ b: string;
  /** expiry, epoch seconds */ e: number;
}

export function signDraftToken(scope: {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  nowMs?: number;
}): string {
  const now = scope.nowMs ?? Date.now();
  const claims: DraftClaims = {
    o: scope.organizationId,
    m: scope.virtualMcpId,
    b: scope.branch,
    e: Math.floor((now + DRAFT_TOKEN_TTL_MS) / 1000),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", getSigningKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyDraftToken(
  token: string,
  expect: {
    organizationId: string;
    virtualMcpId: string;
    branch: string;
    nowMs?: number;
  },
): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(
    createHmac("sha256", getSigningKey()).update(payload).digest("base64url"),
  );
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return false;
  }
  let claims: DraftClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return false;
  }
  const nowSec = Math.floor((expect.nowMs ?? Date.now()) / 1000);
  return (
    claims.o === expect.organizationId &&
    claims.m === expect.virtualMcpId &&
    claims.b === expect.branch &&
    typeof claims.e === "number" &&
    claims.e >= nowSec
  );
}
