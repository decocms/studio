/**
 * OAuth identity helpers.
 *
 * After a downstream OAuth flow we try to derive the *remote* account identity
 * (an email/handle) so that multiple instances of the same app can be told
 * apart in the UI — e.g. "Google Gmail (alice@acme.com)" vs
 * "Google Gmail (bob@acme.com)". Identity is best-effort and purely cosmetic:
 * when it can't be determined the title is left untouched.
 */
import type { OAuthTokenInfo } from "@/web/lib/mcp-oauth";

/**
 * Decode a JWT payload (no signature verification — display only) and pull a
 * human identity claim out of it. Returns null when the token isn't a decodable
 * JWT or carries none of the known claims.
 */
export function decodeJwtEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      ) as Record<string, unknown>;
      if (typeof payload.email === "string") return payload.email;
      if (typeof payload.upn === "string") return payload.upn;
      if (typeof payload.preferred_username === "string")
        return payload.preferred_username;
    }
  } catch {
    // Not a decodable JWT
  }
  return null;
}

/**
 * Best-effort derivation of the remote account identity from an OAuth result.
 * Tries, in order: the OIDC `id_token` JWT, the OIDC userinfo endpoint (for
 * providers that hand back opaque access tokens, e.g. Google), and finally the
 * access token itself decoded as a JWT. Never throws.
 */
export async function extractEmailFromTokenInfo(
  tokenInfo: Pick<
    OAuthTokenInfo,
    "idToken" | "userinfoEndpoint" | "accessToken"
  > | null,
  accessToken: string,
): Promise<string | null> {
  // 1. Try to decode the OIDC id_token JWT (fastest, no extra request)
  const jwtToTry = tokenInfo?.idToken ?? null;
  if (jwtToTry) {
    const email = decodeJwtEmail(jwtToTry);
    if (email) return email;
  }

  // 2. Call the OIDC userinfo endpoint if available (works for providers that
  //    return opaque access tokens, e.g. Google Drive)
  const userinfoEndpoint = tokenInfo?.userinfoEndpoint ?? null;
  if (userinfoEndpoint) {
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const userinfo = (await res.json()) as Record<string, unknown>;
        const email =
          typeof userinfo.email === "string"
            ? userinfo.email
            : typeof userinfo.upn === "string"
              ? userinfo.upn
              : typeof userinfo.preferred_username === "string"
                ? userinfo.preferred_username
                : null;
        if (email) return email;
      }
    } catch {
      // Ignore — userinfo endpoint unavailable or CORS blocked
    }
  }

  // 3. Last resort: try to decode the access token itself as a JWT
  return decodeJwtEmail(accessToken);
}

/**
 * Decorate a connection title with an OAuth identity, e.g.
 * `applyEmailToTitle("Google Gmail", "alice@acme.com")` → "Google Gmail (alice@acme.com)".
 *
 * Idempotent across re-auth: any existing trailing `(...)` segment is replaced
 * rather than appended, so re-authenticating (even as a different account)
 * never produces "App (a) (b)". The email is whitespace-collapsed and
 * length-capped; if it sanitizes to nothing the base title is returned as-is.
 */
export function applyEmailToTitle(currentTitle: string, email: string): string {
  const base = currentTitle.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const clean = email.replace(/\s+/g, " ").trim().slice(0, 120);
  return clean ? `${base} (${clean})` : base;
}
