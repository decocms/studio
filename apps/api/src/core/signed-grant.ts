/**
 * Signed, self-contained grants: `<base64url JSON>.<HMAC>`, signed with the
 * server's own key. Each grant type validates the payload shape itself; this
 * module only proves the payload is one Studio minted.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getSigningKey } from "@/core/signing-key";

function sign(payload: string): string {
  return createHmac("sha256", getSigningKey())
    .update(payload)
    .digest("base64url");
}

export function mintSignedGrant(grant: object): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The parsed payload, or null when the token is forged or malformed. */
export function readSignedGrant(token: string): unknown {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
