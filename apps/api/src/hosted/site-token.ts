/**
 * Site tokens: what a hosted site passes as `createCMS({ token })` to send
 * telemetry. A token is a JWS (compact JWT) signed by Studio with Ed25519:
 *
 *   header  {"alg":"EdDSA","typ":"JWT"}
 *   payload {"site":"<site>","kid":"<token id>","iat":<unix seconds>}
 *
 * No expiry and no revocation: the edge checks only the signature, and stamps
 * the telemetry with the token's site. Issuing always works; Studio lists the
 * tokens it issued (kid and time). The token itself is shown once and never
 * stored.
 */

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
  const list = async (organizationId: string, site: string) =>
    parseRecords(await deps.kv.get(organizationId, recordsKey(site)));

  return {
    list,

    async issue(organizationId: string, site: string) {
      const records = await list(organizationId, site);
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
        tokens: [...records, record],
      });
      return { token, record };
    },
  };
}
