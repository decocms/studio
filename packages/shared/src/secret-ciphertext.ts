/**
 * The `secret` block's ciphertext format, as the Blocks spec documents it
 * (`@decocms/blocks/secrets` produces it, the content protocol checks it):
 *
 * ```
 * v1.<wrappedKey>.<iv>.<ciphertext>
 * ```
 *
 * Each segment is unpadded, canonical base64url: the RSA-OAEP (SHA-256)
 * wrapped AES-256-GCM key (256, 384 or 512 bytes), the 12-byte AES-GCM nonce,
 * and the AES-GCM output with its 16-byte tag (at least 16 bytes).
 *
 * `@decocms/blocks` keeps its own parser private, so Studio carries this small
 * reading of the format: enough to tell an encrypted field from plain text and
 * for tests to decrypt what `encryptSecret` wrote. Encrypting goes through
 * `encryptSecret` from `@decocms/blocks/secrets`.
 */

/** The built-in block type that holds an encrypted value. */
export const SECRET_BLOCK_TYPE = "secret";

const WRAPPED_KEY_BYTES = [256, 384, 512];
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CIPHERTEXT_PATTERN =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The decoded segments of a ciphertext. */
export interface CiphertextParts {
  wrappedKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes unpadded base64url; `null` when `text` isn't canonical base64url. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // One value, one spelling: reject stray low bits.
  return encodeBase64Url(bytes) === text ? bytes : null;
}

/** Splits and decodes a ciphertext; `null` when it isn't well formed. */
export function parseCiphertext(text: unknown): CiphertextParts | null {
  if (typeof text !== "string" || !CIPHERTEXT_PATTERN.test(text)) return null;
  const [, rawKey = "", rawIv = "", rawCiphertext = ""] = text.split(".");
  const wrappedKey = decodeBase64Url(rawKey);
  const iv = decodeBase64Url(rawIv);
  const ciphertext = decodeBase64Url(rawCiphertext);
  if (!wrappedKey || !iv || !ciphertext) return null;
  if (
    !WRAPPED_KEY_BYTES.includes(wrappedKey.byteLength) ||
    iv.byteLength !== IV_BYTES ||
    ciphertext.byteLength < GCM_TAG_BYTES
  ) {
    return null;
  }
  return { wrappedKey, iv, ciphertext };
}

/** True when `ciphertext` is a well-formed `v1` ciphertext. */
export function isWellFormedCiphertext(
  ciphertext: unknown,
): ciphertext is string {
  return parseCiphertext(ciphertext) !== null;
}

/** A `PUBLIC KEY` PEM block for SPKI `der` bytes, with 64-character lines. */
export function publicKeyPemFromDer(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}
