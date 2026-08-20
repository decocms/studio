/**
 * A site slug is the object-key prefix namespace in the shared tenant bucket
 * (`<slug>/...`) and is interpolated into IAM session-policy resource ARNs, so
 * the strict lowercase whitelist is a load-bearing security control — a `*` or
 * `/` would broaden the grant. Length is bounded so `s3-<slug>` stays within
 * the 64-char STS RoleSessionName limit.
 */
export const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function isValidSiteSlug(slug: string): boolean {
  return SITE_SLUG_RE.test(slug);
}

/**
 * The site slug an agent resolves against — its managed-asset tenancy and the
 * storefront "." shortcut (`/api/_editor-resolve`).
 *
 * `metadata.siteSlug` is stamped once at import and never re-derived, so it
 * survives a rename. The `title` fallback covers agents imported before that
 * key was persisted, where the title *was* the effective slug. Because a title
 * is user-editable, nothing new should key off it — resolve through here.
 */
export function resolveAgentSiteSlug(
  agent:
    | {
        title?: string | null;
        metadata?: { siteSlug?: string | null } | null;
      }
    | null
    | undefined,
): string | null {
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

  return (
    normalize(agent?.metadata?.siteSlug) || normalize(agent?.title) || null
  );
}
