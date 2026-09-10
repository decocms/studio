/**
 * The key Studio signs its own short-lived tokens with.
 *
 * One key for every HMAC token the server mints and later verifies itself —
 * reviewer identities, attachment download grants. Derived from the auth
 * secret so it survives a restart; a random key is the unit-test fallback,
 * where nothing outlives the process.
 */

import { randomBytes } from "node:crypto";
import { getSettings } from "@/settings";

let signingKey: Buffer | null = null;

export function getSigningKey(): Buffer {
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
