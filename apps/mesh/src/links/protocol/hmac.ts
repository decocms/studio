import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const SIG_HEADER = "X-Mesh-Signature";
const TS_HEADER = "X-Mesh-Timestamp";
const NONCE_HEADER = "X-Mesh-Nonce";

const MAX_TIMESTAMP_DRIFT_SECONDS = 30;

export interface RequestSignatureHeaders {
  [SIG_HEADER]: string;
  [TS_HEADER]: string;
  [NONCE_HEADER]: string;
}

export interface SignInput {
  secret: string;
  method: string;
  path: string;
  body: string;
  /** Test-only override. */
  timestamp?: number;
  /** Test-only override. */
  nonce?: string;
}

export function signRequest(input: SignInput): RequestSignatureHeaders {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const bodyHash = sha256Hex(input.body);
  const stringToSign = [
    input.method.toUpperCase(),
    input.path,
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
  const signature = createHmac("sha256", input.secret)
    .update(stringToSign)
    .digest("hex");
  return {
    [SIG_HEADER]: signature,
    [TS_HEADER]: String(timestamp),
    [NONCE_HEADER]: nonce,
  };
}

export interface VerifyInput {
  secret: string;
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | undefined>;
  /**
   * Caller-provided nonce cache. Returning `true` means "this nonce has
   * been seen recently; reject as replay." The verifier never mutates;
   * the caller records the nonce on successful verification.
   */
  seenNonce: (nonce: string) => boolean;
  /** Test-only override of "now" in seconds. */
  now?: number;
}

export type VerifyResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "missing_headers"
        | "timestamp_drift"
        | "nonce_replay"
        | "bad_signature";
    };

export function verifyRequest(input: VerifyInput): VerifyResult {
  const sig =
    input.headers[SIG_HEADER] ?? input.headers[SIG_HEADER.toLowerCase()];
  const tsRaw =
    input.headers[TS_HEADER] ?? input.headers[TS_HEADER.toLowerCase()];
  const nonce =
    input.headers[NONCE_HEADER] ?? input.headers[NONCE_HEADER.toLowerCase()];
  if (!sig || !tsRaw || !nonce) {
    return { valid: false, reason: "missing_headers" };
  }

  const timestamp = Number(tsRaw);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "missing_headers" };
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    return { valid: false, reason: "timestamp_drift" };
  }
  if (input.seenNonce(nonce)) return { valid: false, reason: "nonce_replay" };

  const bodyHash = sha256Hex(input.body);
  const stringToSign = [
    input.method.toUpperCase(),
    input.path,
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
  const expected = createHmac("sha256", input.secret)
    .update(stringToSign)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length) return { valid: false, reason: "bad_signature" };
  if (!timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };
  return { valid: true };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
