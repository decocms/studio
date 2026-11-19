/**
 * Claims for the MCP OAuth server's UserInfo endpoint (OIDC Core 5.3).
 *
 * Better Auth's `mcp()` plugin advertises `/api/auth/mcp/userinfo` in its
 * discovery metadata but never serves it, and it signs id_tokens with a
 * per-request key no client can verify. Clients that sign people in with
 * Studio need a verifiable way to read the identity behind an access token;
 * this is it.
 */

/** Longest `picture` URL returned; avatars stored inline would blow up the response. */
const MAX_PICTURE_LENGTH = 2048;

export interface UserinfoUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  image?: string | null;
}

export interface UserinfoToken {
  accessTokenExpiresAt: Date | string | null;
  scopes: string | null;
}

/** The bearer token of an `Authorization` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/** A token without an expiry, or with an unparseable one, is not usable. */
export function isTokenUsable(token: UserinfoToken, now: Date): boolean {
  if (!token.accessTokenExpiresAt) return false;
  const expiresAt = new Date(token.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function grantedScopes(scopes: string | null): Set<string> {
  return new Set((scopes ?? "").split(/\s+/).filter(Boolean));
}

function pictureOf(image: string | null | undefined): string | undefined {
  if (!image || image.length > MAX_PICTURE_LENGTH) return undefined;
  try {
    const url = new URL(image);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** `sub` always; email claims with `email`; profile claims with `profile`. */
export function userinfoClaims(
  user: UserinfoUser,
  scopes: Set<string>,
): Record<string, string | boolean> {
  const claims: Record<string, string | boolean> = { sub: user.id };
  if (scopes.has("email")) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified === true;
  }
  if (scopes.has("profile")) {
    const name = user.name?.trim();
    if (name) {
      const [given, ...rest] = name.split(/\s+/);
      claims.name = name;
      if (given) claims.given_name = given;
      if (rest.length) claims.family_name = rest.join(" ");
    }
    const picture = pictureOf(user.image);
    if (picture) claims.picture = picture;
  }
  return claims;
}
