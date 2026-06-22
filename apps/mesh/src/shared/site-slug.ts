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
