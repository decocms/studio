/**
 * Site tokens: what a hosted site passes as `createCMS({ token })` to send
 * telemetry. A token is a JWS (compact JWT) signed by Studio with Ed25519:
 *
 *   header  {"alg":"EdDSA","typ":"JWT"}
 *   payload {"site":"<site>","kid":"<token id>","iat":<unix seconds>}
 *
 * No expiry: a token lives until it is revoked, which writes `revoked:<kid>`
 * to the denylist the edge checks. Studio keeps at most two unrevoked tokens
 * per site (issue the new one, deploy it, revoke the old one); that is a
 * hygiene rule here only, the edge checks just the signature and denylist.
 * The token itself is shown once and never stored.
 */

import type { KVStorage } from "@/storage/kv";
import { type Denylist, denylistKeys } from "./denylist";

const MAX_ACTIVE_TOKENS = 2;

export interface SiteTokenRecord {
  kid: string;
  /** Issued at, Unix seconds (the token's `iat`). */
  iat: number;
  /** ISO time of revocation; absent while active. */
  revokedAt?: string;
}

/** A third active token was asked for. */
export class TooManySiteTokensError extends Error {
  constructor() {
    super(
      `a site can have at most ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`,
    );
    this.name = "TooManySiteTokensError";
  }
}

export class SiteTokenNotFoundError extends Error {
  constructor() {
    super("site token not found");
    this.name = "SiteTokenNotFoundError";
  }
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
  denylist: Denylist;
}) {
  const list = async (organizationId: string, site: string) =>
    parseRecords(await deps.kv.get(organizationId, recordsKey(site)));

  return {
    list,

    async issue(organizationId: string, site: string) {
      const records = await list(organizationId, site);
      if (records.filter((r) => !r.revokedAt).length >= MAX_ACTIVE_TOKENS) {
        throw new TooManySiteTokensError();
      }
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

    async revoke(organizationId: string, site: string, kid: string) {
      const records = await list(organizationId, site);
      const target = records.find((r) => r.kid === kid);
      if (!target) throw new SiteTokenNotFoundError();
      if (target.revokedAt) return target;
      // The edge's denylist first: a token is only "revoked" once it is.
      await deps.denylist.put(denylistKeys.revoked(kid));
      const revoked = { ...target, revokedAt: new Date().toISOString() };
      await deps.kv.set(organizationId, recordsKey(site), {
        tokens: records.map((r) => (r.kid === kid ? revoked : r)),
      });
      return revoked;
    },
  };
}
