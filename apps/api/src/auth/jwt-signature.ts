/**
 * Asymmetric signing for Studio proxy tokens (x-mesh-token / x-studio-token).
 *
 * Downstream MCP apps hold a connection bearer but not STUDIO_JWT_SECRET, so
 * they can't verify today's HS256 proxy token (see jwt.ts) and `@decocms/runtime`
 * currently only decodes it without checking the signature. This module signs
 * with EdDSA and publishes the public key as a JWKS, so apps can verify locally
 * via `createRemoteJWKSet` without round-tripping to Studio.
 *
 * The keypair is generated once per process (same "not persistent across
 * restarts" trade-off already accepted for STUDIO_JWT_SECRET in ./jwt.ts): a
 * restart rotates the key and invalidates in-flight tokens, which is safe
 * because proxy tokens are short-lived (minutes), not a stored credential.
 */

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";

const ALG = "EdDSA";

interface SigningKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

let signingKeys: Promise<SigningKeys> | null = null;

async function generateSigningKeys(): Promise<SigningKeys> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { privateKey, publicJwk, kid };
}

function getSigningKeys(): Promise<SigningKeys> {
  if (!signingKeys) {
    signingKeys = generateSigningKeys();
  }
  return signingKeys;
}

/**
 * Sign a proxy-token payload with the process's EdDSA key.
 *
 * @param payload - Token claims (same shape as issueStudioToken's payload)
 * @param aud - The connectionId this token is scoped to, so a token minted
 *   for one app can't be replayed against another
 * @param expiresIn - Expiration time (default: 5 minutes)
 */
export async function signProxyToken(
  payload: JWTPayload,
  aud: string,
  expiresIn: string = "5m",
): Promise<string> {
  const { privateKey, kid } = await getSigningKeys();

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, typ: "JWT", kid })
    .setIssuedAt()
    .setIssuer("studio")
    .setAudience(aud)
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

/** The public key set to publish at /.well-known/jwks.json. */
export async function getProxyTokenJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk, kid } = await getSigningKeys();
  return {
    keys: [{ ...publicJwk, kid, alg: ALG, use: "sig" }],
  };
}
