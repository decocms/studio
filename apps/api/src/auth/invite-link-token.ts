/** 32 random bytes, URL-safe: the secret half of an invite link. */
export function generateInviteLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** Links are stored and looked up by this digest, never by the raw token. */
export async function hashInviteLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString("hex");
}

export const INVITE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A redirect target must stay inside the inviting org: a relative path under
 * `/<slug>`, never protocol-relative (`//host`) or backslash-escaped.
 */
export function isSafeInviteRedirect(path: string, orgSlug: string): boolean {
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  const base = `/${orgSlug}`;
  return (
    path === base ||
    path.startsWith(`${base}/`) ||
    path.startsWith(`${base}?`) ||
    path.startsWith(`${base}#`)
  );
}
