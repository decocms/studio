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

/**
 * The site an agent's analytics reads (Monitor, experiment results) resolve
 * against. `metadata.analyticsSiteSlug` overrides it for a project whose
 * production traffic is reported under another site than the one its code lives
 * in — a TanStack migration (`acme-tanstack`) serving the domains, warehouse
 * facts and analytics host of the original `acme`. Hosting, assets and the
 * editor keep `resolveAgentSiteSlug`; only analytics reads follow this. An
 * override that is not a valid slug is ignored rather than trusted.
 */
export function resolveAnalyticsSiteSlug(
  agent:
    | {
        title?: string | null;
        metadata?: {
          siteSlug?: string | null;
          analyticsSiteSlug?: string | null;
        } | null;
      }
    | null
    | undefined,
): string | null {
  const override =
    typeof agent?.metadata?.analyticsSiteSlug === "string"
      ? agent.metadata.analyticsSiteSlug.trim().toLowerCase()
      : "";
  if (override && isValidSiteSlug(override)) return override;
  return resolveAgentSiteSlug(agent);
}
