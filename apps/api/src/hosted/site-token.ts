/**
 * Site tokens: what a hosted site passes as `createCMS({ token })` to send
 * telemetry. A token is a JWS (compact JWT) signed by Studio with Ed25519:
 *
 *   header  {"alg":"EdDSA","typ":"JWT"}
 *   payload {"site":"<site>","kid":"<token id>","iat":<unix seconds>}
 *
 * A token has no expiry. It is good for two things:
 *
 *   - telemetry: the edge checks only the signature and stamps the telemetry
 *     with the token's site. Revoking a token does not stop its telemetry.
 *   - `PUT /api/cms/:site/schema` (`deco schema push` in the site's CI): Studio
 *     checks the signature, that `site` is the path's site, and that `kid` is
 *     still in the site's issued records and not revoked. No other CMS route
 *     takes a site token.
 *
 * Issuing always works; Studio lists the tokens it issued (kid and time) and
 * revokes one by kid. The token itself is shown once and never stored.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { KVStorage } from "@/storage/kv";

export interface SiteTokenRecord {
  kid: string;
  /** Issued at, Unix seconds (the token's `iat`). */
  iat: number;
}

// OPEN: O-S2 — token records live in the org KV per site; no migration.
function recordsKey(site: string): string {
  return `site-tokens:${site}`;
}

/**
 * Revocation's own key, which `issue` never writes: the records list is a
 * read-modify-write with no compare-and-swap, so an `issue` racing a revoke
 * can write the revoked record back. The marker keeps it revoked.
 */
function revokedKey(site: string, kid: string): string {
  return `site-tokens-revoked:${site}:${kid}`;
}

function parseRecords(
  value: Record<string, unknown> | null,
): SiteTokenRecord[] {
  const tokens = value?.tokens;
  if (!Array.isArray(tokens)) return [];
  return tokens.filter(
    (t): t is SiteTokenRecord =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as SiteTokenRecord).kid === "string" &&
      typeof (t as SiteTokenRecord).iat === "number",
  );
}

const b64u = (bytes: Uint8Array | ArrayBuffer) =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("base64url");

// OPEN: O-S6 — the signing key is base64 PKCS8 (`openssl genpkey -algorithm ed25519`).
export function importSigningKey(base64Pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(base64Pkcs8, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** The public half of the base64 PKCS8 signing key, for verifying. */
export function importVerifyKey(base64Pkcs8: string): Promise<CryptoKey> {
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.from(base64Pkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  );
  return crypto.subtle.importKey(
    "spki",
    publicKey.export({ format: "der", type: "spki" }),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

export interface SiteTokenClaims {
  site: string;
  kid: string;
  iat: number;
}

const MAX_TOKEN_LENGTH = 2048;
const B64U = /^[A-Za-z0-9_-]+$/;
const HeaderSchema = z.object({ alg: z.literal("EdDSA") });
const ClaimsSchema = z.object({
  site: z.string().min(1),
  kid: z.string().min(1),
  iat: z.number().int(),
});

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The claims of a site token Studio signed, or null: not a compact JWS, not
 * EdDSA, a payload that isn't `{site, kid, iat}`, or a bad signature. Says
 * nothing about revocation (`createSiteTokens().isLive`).
 */
export async function verifySiteToken(
  key: CryptoKey,
  token: string,
): Promise<SiteTokenClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64U.test(p))) return null;
  const [header, payload, signature] = parts as [string, string, string];
  if (!HeaderSchema.safeParse(decodeJson(header)).success) return null;
  const claims = ClaimsSchema.safeParse(decodeJson(payload));
  if (!claims.success) return null;
  const valid = await crypto.subtle
    .verify(
      { name: "Ed25519" },
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    .catch(() => false);
  return valid ? claims.data : null;
}

async function signSiteToken(
  key: CryptoKey,
  payload: { site: string; kid: string; iat: number },
): Promise<string> {
  const encode = (value: unknown) =>
    b64u(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
    site: payload.site,
    kid: payload.kid,
    iat: payload.iat,
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64u(signature)}`;
}

export function createSiteTokens(deps: {
  kv: KVStorage;
  signingKey: () => Promise<CryptoKey>;
}) {
  const records = async (organizationId: string, site: string) =>
    parseRecords(await deps.kv.get(organizationId, recordsKey(site)));
  const isRevoked = async (organizationId: string, site: string, kid: string) =>
    (await deps.kv.get(organizationId, revokedKey(site, kid))) !== null;
  const list = async (organizationId: string, site: string) => {
    const all = await records(organizationId, site);
    const revoked = await Promise.all(
      all.map((r) => isRevoked(organizationId, site, r.kid)),
    );
    return all.filter((_, i) => !revoked[i]);
  };

  return {
    list,

    /** Whether `kid` was issued for the site and isn't revoked. */
    async isLive(organizationId: string, site: string, kid: string) {
      const all = await records(organizationId, site);
      if (!all.some((r) => r.kid === kid)) return false;
      return !(await isRevoked(organizationId, site, kid));
    },

    /** Revokes `kid`; false when the site has no live token with it. */
    async revoke(organizationId: string, site: string, kid: string) {
      const all = await records(organizationId, site);
      if (!all.some((r) => r.kid === kid)) return false;
      if (await isRevoked(organizationId, site, kid)) return false;
      await deps.kv.set(organizationId, revokedKey(site, kid), {
        revokedAt: Math.floor(Date.now() / 1000),
      });
      await deps.kv.set(organizationId, recordsKey(site), {
        tokens: all.filter((r) => r.kid !== kid),
      });
      return true;
    },

    async issue(organizationId: string, site: string) {
      const existing = await records(organizationId, site);
      // OPEN: O-15 — kid is this token's id: 16 random bytes, base64url.
      const record: SiteTokenRecord = {
        kid: b64u(crypto.getRandomValues(new Uint8Array(16))),
        iat: Math.floor(Date.now() / 1000),
      };
      const token = await signSiteToken(await deps.signingKey(), {
        site,
        ...record,
      });
      await deps.kv.set(organizationId, recordsKey(site), {
        tokens: [...existing, record],
      });
      return { token, record };
    },
  };
}
