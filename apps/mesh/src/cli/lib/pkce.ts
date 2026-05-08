import { createHash, randomBytes } from "node:crypto";

/**
 * Generate an OAuth 2.1 PKCE pair (RFC 7636).
 *
 * Returns a high-entropy code_verifier and its derived S256 code_challenge.
 * The verifier is sent to the token endpoint to prove possession; the
 * challenge is sent up-front to the authorize endpoint.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
