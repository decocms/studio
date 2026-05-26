/**
 * GitHub App JWT signing (RS256).
 *
 * GitHub Apps authenticate to GitHub itself with a short-lived JWT signed
 * with the App's private key. The JWT is then exchanged for an installation
 * access token via `POST /app/installations/:id/access_tokens`.
 *
 * Spec: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * Implementation note: we use node `crypto.createSign` for RS256 rather than
 * pulling in `jsonwebtoken` — the JWT format is simple enough that the dep
 * isn't worth it, and it avoids a runtime surprise if `jsonwebtoken` ships
 * a breaking change.
 */

import { createSign } from "node:crypto";

function base64url(input: Buffer | string): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Build a short-lived (10 minute) App JWT.
 *
 * GitHub allows up to 10 minutes; we use 9 to leave clock-skew headroom on
 * both sides. The `iat` is backdated 60s for the same reason — clusters
 * with skewed clocks otherwise fail with "iat is in the future".
 */
export function buildAppJwt(params: {
  appId: string;
  privateKeyPem: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: params.appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(params.privateKeyPem);
  const encodedSignature = base64url(signature);

  return `${signingInput}.${encodedSignature}`;
}
