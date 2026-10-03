/**
 * The secret ciphertext format. The implementation is a dependency-free leaf
 * module of the SDK (`src/v8/ciphertext.ts`), where the `secret` built-in
 * decrypts it; the protocol re-exports it for its secret guard.
 */
/**
 * The `secret` block's ciphertext format, in one place: the secret guard
 * checks it, and `encryptSecret` (`@decocms/blocks/secrets`) produces it.
 *
 * ```
 * v1.<wrappedKey>.<iv>.<ciphertext>
 * ```
 *
 * Each segment is unpadded base64url. A fresh AES-256-GCM key encrypts the
 * UTF-8 value; the key is wrapped with the site's RSA public key using
 * RSA-OAEP with SHA-256.
 *
 * - `wrappedKey` — the RSA-OAEP output: as long as the modulus, so 256, 384
 *   or 512 bytes (2048-, 3072- or 4096-bit keys; `deco` creates 3072-bit ones).
 * - `iv` — the AES-GCM nonce: exactly 12 bytes.
 * - `ciphertext` — the AES-GCM output, its 16-byte tag included: at least 16 bytes.
 *
 * Checking the structure needs no key, so the content protocol and
 * `deco check` refuse text that merely looks like a ciphertext (`v1.hunter2`).
 * Web Crypto only: runs in browsers, on Workers and on Node.
 */

/** The format version every ciphertext starts with. */
export const CIPHERTEXT_VERSION = "v1";

/** The wrapped-key lengths a ciphertext may carry: 2048-, 3072- and 4096-bit RSA. */
export const WRAPPED_KEY_BYTES: readonly number[] = [256, 384, 512];

/** The AES-GCM nonce length. */
export const IV_BYTES = 12;

/** The AES-GCM authentication tag length, the smallest ciphertext segment. */
export const GCM_TAG_BYTES = 16;

/**
 * The shape of a ciphertext: `v1.` and three base64url segments. A match is
 * necessary but not sufficient; `parseCiphertext` also checks segment lengths.
 */
export const CIPHERTEXT_PATTERN =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The decoded segments of a ciphertext. */
export interface CiphertextParts {
  wrappedKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes unpadded base64url; `null` when `text` isn't canonical base64url. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
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
  // Reject non-canonical encodings (stray low bits), so one value has one spelling.
  return encodeBase64Url(bytes) === text ? bytes : null;
}

const validParts = ({ wrappedKey, iv, ciphertext }: CiphertextParts) =>
  WRAPPED_KEY_BYTES.includes(wrappedKey.byteLength) &&
  iv.byteLength === IV_BYTES &&
  ciphertext.byteLength >= GCM_TAG_BYTES;

/** Splits and decodes a ciphertext; `null` when it isn't well formed. */
export function parseCiphertext(text: unknown): CiphertextParts | null {
  if (typeof text !== "string" || !CIPHERTEXT_PATTERN.test(text)) return null;
  const [, rawKey, rawIv, rawCiphertext] = text.split(".");
  const wrappedKey = decodeBase64Url(rawKey!);
  const iv = decodeBase64Url(rawIv!);
  const ciphertext = decodeBase64Url(rawCiphertext!);
  if (!wrappedKey || !iv || !ciphertext) return null;
  const parts = { wrappedKey, iv, ciphertext };
  return validParts(parts) ? parts : null;
}

/** Joins decoded segments into a ciphertext. Throws when a segment has the wrong length. */
export function formatCiphertext(parts: CiphertextParts): string {
  if (!validParts(parts)) {
    throw new RangeError(
      `a ciphertext needs a ${WRAPPED_KEY_BYTES.join("/")}-byte wrapped key, a ${IV_BYTES}-byte iv and at least ${GCM_TAG_BYTES} bytes of ciphertext`,
    );
  }
  return [
    CIPHERTEXT_VERSION,
    encodeBase64Url(parts.wrappedKey),
    encodeBase64Url(parts.iv),
    encodeBase64Url(parts.ciphertext),
  ].join(".");
}

const PEM_BLOCK = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/g;

/** The DER bytes of a single `PUBLIC KEY` PEM block; `null` for anything else. */
export function publicKeyDerFromPem(pem: string): Uint8Array | null {
  const blocks = [...pem.matchAll(PEM_BLOCK)];
  const block = blocks[0];
  if (blocks.length !== 1 || !block || block[1] !== "PUBLIC KEY") return null;
  if (pem.replace(block[0], "").trim() !== "") return null;
  const body = (block[2] ?? "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A `PUBLIC KEY` PEM block for SPKI `der` bytes, with 64-character lines. */
export function publicKeyPemFromDer(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Encrypts `value` for the holder of the private key matching `publicKeyPem`
 * (an SPKI `PUBLIC KEY` PEM, such as `.deco/secrets.pub`).
 */
export async function encryptToCiphertext(
  publicKeyPem: string,
  value: string,
): Promise<string> {
  const der = publicKeyDerFromPem(publicKeyPem);
  if (!der)
    throw new TypeError("the public key must be a single PUBLIC KEY PEM block");
  const rsa = await crypto.subtle.importKey(
    "spki",
    der as BufferSource,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey("raw", aesKey, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aes,
      new TextEncoder().encode(value),
    ),
  );
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, aesKey),
  );
  aesKey.fill(0);
  return formatCiphertext({ wrappedKey, iv, ciphertext });
}
