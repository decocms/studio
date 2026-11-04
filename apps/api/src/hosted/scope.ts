/**
 * The site id a project names, for linking it in `org_sites`
 * (hosted/claim-site.ts and the admin backfill). The hosted CMS itself is
 * keyed by the `org_sites` row (`/api/:org/cms/:site`), never by a project.
 */

import { isValidSiteSlug } from "@decocms/shared/site-slug";

/** The site id a project names in `metadata.siteSlug` (what it was created with). */
export function projectSite(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const slug = metadata?.siteSlug;
  return typeof slug === "string" && isValidSiteSlug(slug) ? slug : null;
}
