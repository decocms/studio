/**
 * Crypto for password-protected org-fs sharing — scrypt password hashes and
 * HMAC-signed unlock tokens. See `.context/file-share-password-spec.md`.
 *
 * The hash + per-node `share_secret` live in the manifest; the unlock token is
 * carried in an httpOnly cookie. A password change rotates the node's secret,
 * which is embedded in the token, so previously-issued cookies stop verifying.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getSettings } from "../settings";

const SCRYPT_KEYLEN = 64;
// Async scrypt — the `/unlock` route is public and unauthenticated, so the sync
// variant would block the event loop ~tens of ms per attempt and serialize
// concurrent unlocks.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** scrypt hash as `scrypt$<saltHex>$<derivedHex>`. */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time verify against a `hashSharePassword` output. */
export async function verifySharePassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  // Reject malformed/empty hashes — otherwise a zero-length expected hash would
  // timing-safe-equal an empty derivation and accept any password.
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length);
  } catch {
    return false;
  }
  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}

/** Random per-node secret; rotated on every password change. */
export function generateShareSecret(): string {
  return randomBytes(16).toString("hex");
}

// --- unlock token (HMAC over the governing node + secret + expiry) ---------

let signingKey: Buffer | null = null;
function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  let secret: string | undefined;
  try {
    const settings = getSettings();
    secret = settings.studioJwtSecret ?? settings.betterAuthSecret;
  } catch {
    // Settings not initialized (e.g. unit tests) — fall back like auth/jwt.ts.
    secret = undefined;
  }
  signingKey = secret ? Buffer.from(secret) : randomBytes(32);
  return signingKey;
}

interface UnlockClaims {
  /** org id */ o: string;
  /** volume */ v: string;
  /** governing node path */ p: string;
  /** node share_secret version */ s: string;
  /** expiry, epoch seconds */ e: number;
}

export function signUnlockToken(claims: UnlockClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", getSigningKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${mac}`;
}

/**
 * Verify a token for a governing node. Returns its path on success, else null.
 * Fails closed on a stale secret (rotation), expiry, or org/volume mismatch.
 */
export function verifyUnlockToken(
  token: string,
  expect: { org: string; volume: string; secret: string; nowSec: number },
): { govPath: string } | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(
    createHmac("sha256", getSigningKey()).update(payload).digest("base64url"),
  );
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return null;
  }
  let claims: UnlockClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (
    claims.o !== expect.org ||
    claims.v !== expect.volume ||
    claims.s !== expect.secret ||
    typeof claims.e !== "number" ||
    claims.e < expect.nowSec
  ) {
    return null;
  }
  return { govPath: claims.p };
}

/** Opaque, stable cookie name for a governing share node (not a secret). */
export function unlockCookieName(
  org: string,
  volume: string,
  govPath: string,
): string {
  const h = createHmac("sha256", "fsunlock-name")
    .update(`${org}:${volume}:${govPath}`)
    .digest("hex")
    .slice(0, 16);
  return `fsu_${h}`;
}
