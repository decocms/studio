/**
 * JWT Utility for Mesh Proxy Tokens
 *
 * Uses HMAC SHA-256 (HS256) for signing JWTs that can be:
 * - Decoded directly by downstream services to read payload
 * - Verified by downstream services using the shared secret
 *
 * The secret is loaded from MESH_JWT_SECRET environment variable.
 * If not set, a random secret is generated (not persistent across restarts).
 */

import { decodeJwt, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { randomBytes } from "crypto";
import { getSettings } from "../settings";

// JWT signing secret - loaded from env or generated
let jwtSecret: Uint8Array | null = null;

/**
 * Get or generate the JWT signing secret
 */
function getSecret(): Uint8Array {
  if (jwtSecret) {
    return jwtSecret;
  }

  const settings = getSettings();
  const envSecret = settings.meshJwtSecret ?? settings.betterAuthSecret;
  if (envSecret) {
    jwtSecret = new TextEncoder().encode(envSecret);
  } else {
    // Generate a random secret - note: not persistent across restarts
    console.warn(
      "MESH_JWT_SECRET not set - generating random secret (not persistent)",
    );
    jwtSecret = new Uint8Array(randomBytes(32));
  }

  return jwtSecret;
}

/**
 * Mesh proxy token payload
 */
export interface MeshTokenPayload {
  /** User ID who initiated the request */
  sub: string;
  /** User identity propagated to downstream apps via x-mesh-token */
  user?: {
    id: string;
    email?: string;
    name?: string;
    image?: string;
    role?: string;
  };
  /** Metadata */
  metadata?: {
    /** Configuration state */
    state?: Record<string, unknown>;
    /** Mesh instance URL */
    meshUrl: string;
    /** Connection ID this token was issued for */
    connectionId: string;
    /** Organization ID */
    organizationId?: string;
    /** Organization display name */
    organizationName?: string;
    /** Organization URL slug */
    organizationSlug?: string;
  };
  /** Permissions per connection: { [connectionId]: [scopes] } */
  permissions: Record<string, string[]>;
}

export type MeshJwtPayload = JWTPayload & MeshTokenPayload;

/**
 * Issue a signed JWT with mesh token payload
 *
 * @param payload - The token payload
 * @param expiresIn - Expiration time (default: 5 minutes)
 * @returns Signed JWT string
 */
export async function issueMeshToken(
  payload: MeshTokenPayload,
  expiresIn: string = "5m",
): Promise<string> {
  const secret = getSecret();

  return await new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

/**
 * Verify and decode a mesh token
 *
 * @param token - JWT string to verify
 * @returns Decoded payload if valid, undefined if invalid
 */
export async function verifyMeshToken(
  token: string,
): Promise<MeshJwtPayload | undefined> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload as MeshJwtPayload;
  } catch {
    return undefined;
  }
}

/**
 * Decode a mesh token without verification
 *
 * Use this when you just need to read the payload.
 * WARNING: Does not verify signature - do not trust for authorization!
 *
 * @param token - JWT string to decode
 * @returns Decoded payload
 */
export function decodeMeshToken(token: string): MeshJwtPayload {
  return decodeJwt<MeshTokenPayload>(token);
}

/**
 * Mint a gateway-compatible Mesh JWT for the given user.
 *
 * Uses the same MESH_JWT_SECRET and payload shape that the AI Gateway's
 * verifyMeshJwt() expects: { iss: "mesh", sub: userId }.
 * This is intentionally simpler than issueMeshToken — downstream services
 * only need the user identity, not the full proxy-token metadata.
 *
 * @param userId - The authenticated user's ID
 * @param expiresIn - Expiration time in seconds (default: 1 hour)
 */
export async function mintGatewayJwt(
  userId: string,
  expiresIn = 3600,
): Promise<string> {
  const settings = getSettings();
  const gwSecret = settings.meshJwtSecret ?? settings.betterAuthSecret;
  if (!gwSecret) {
    throw new Error(
      "A deterministic JWT secret is required to mint gateway JWTs — set MESH_JWT_SECRET or BETTER_AUTH_SECRET",
    );
  }
  const secret = new TextEncoder().encode(gwSecret);
  return await new SignJWT({ iss: "mesh", sub: userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(secret);
}
