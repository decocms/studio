import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "stv";
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PREFIX_CHARS = 12;
const TOKEN_CHAR_PATTERN = /^[A-Za-z0-9_-]+$/;

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface GeneratedWorkloadToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function hashWorkloadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyWorkloadToken(token: string, hash: string): boolean {
  const actual = Buffer.from(hashWorkloadToken(token), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseWorkloadTokenPrefix(token: string): string | null {
  const prefixStart = TOKEN_PREFIX.length + 1;
  const secretSeparator = prefixStart + TOKEN_PREFIX_CHARS;

  if (
    !token.startsWith(`${TOKEN_PREFIX}_`) ||
    token.length <= secretSeparator + 1 ||
    token[secretSeparator] !== "_"
  ) {
    return null;
  }

  const prefix = token.slice(prefixStart, secretSeparator);
  const secret = token.slice(secretSeparator + 1);
  if (!TOKEN_CHAR_PATTERN.test(prefix) || !TOKEN_CHAR_PATTERN.test(secret)) {
    return null;
  }

  return prefix;
}

export function generateWorkloadToken(): GeneratedWorkloadToken {
  const secret = base64Url(randomBytes(TOKEN_RANDOM_BYTES));
  const prefix = secret.slice(0, TOKEN_PREFIX_CHARS);
  const plaintext = `${TOKEN_PREFIX}_${prefix}_${secret}`;

  return {
    plaintext,
    prefix,
    hash: hashWorkloadToken(plaintext),
  };
}
