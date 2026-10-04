/**
 * Signed capabilities for readers that cannot carry a Studio session. Same
 * sign/verify shape as `file-storage/share-password.ts` unlock tokens.
 *
 * - The legacy draft token authorizes the anonymous decofile read a v7 site
 *   makes for its `?__draft=` pointer: one (org, virtualMcpId, branch) scope.
 * - The overlay grant authorizes one site's immutable draft overlay (blocks
 *   docs: /next/content-delivery#exact-draft-previews): the site, the overlay
 *   version and an expiry, never a moving branch.
 * - The site token is the bearer a connected site sends on every delivery
 *   request (`DECO_SITE_TOKEN`), derived from the site id.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSettings } from "../settings";

/** Long enough that an open editor session never sees an expiry (grants are
 * reissued while it is open), short enough that a leaked preview URL goes
 * stale within a working day. */
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

function mac(payload: string): string {
  return createHmac("sha256", getSigningKey())
    .update(payload)
    .digest("base64url");
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** The claims of a token this key signed, or null. */
function open(token: string): Record<string, unknown> | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  if (!sameString(token.slice(dot + 1), mac(payload))) return null;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    );
    return typeof claims === "object" && claims !== null
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expiry(nowMs: number | undefined): number {
  return Math.floor(((nowMs ?? Date.now()) + DRAFT_TOKEN_TTL_MS) / 1000);
}

function live(claims: Record<string, unknown>, nowMs?: number): boolean {
  return (
    typeof claims.e === "number" &&
    claims.e >= Math.floor((nowMs ?? Date.now()) / 1000)
  );
}

export function signDraftToken(scope: {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  nowMs?: number;
}): string {
  return sign({
    o: scope.organizationId,
    m: scope.virtualMcpId,
    b: scope.branch,
    e: expiry(scope.nowMs),
  });
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
  const claims = open(token);
  return (
    claims !== null &&
    claims.o === expect.organizationId &&
    claims.m === expect.virtualMcpId &&
    claims.b === expect.branch &&
    live(claims, expect.nowMs)
  );
}

/** A grant for one site's overlay version, and when it expires. */
export function signOverlayGrant(scope: {
  site: string;
  version: string;
  nowMs?: number;
}): { token: string; expiresAt: string } {
  const e = expiry(scope.nowMs);
  return {
    token: sign({ t: "overlay", s: scope.site, v: scope.version, e }),
    expiresAt: new Date(e * 1000).toISOString(),
  };
}

/** The overlay version a live grant for `site` authorizes, or null. */
export function overlayGrantVersion(
  token: string,
  expect: { site: string; nowMs?: number },
): string | null {
  const claims = open(token);
  return claims !== null &&
    claims.t === "overlay" &&
    claims.s === expect.site &&
    typeof claims.v === "string" &&
    live(claims, expect.nowMs)
    ? claims.v
    : null;
}

export function siteToken(site: string): string {
  return `dst_${mac(`site-token:v1:${site}`)}`;
}

export function verifySiteToken(site: string, token: string): boolean {
  return sameString(token, siteToken(site));
}
