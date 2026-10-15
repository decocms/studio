import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { SiteSlugImmutableError } from "../../storage/org-sites";

const normalize = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Refuse a metadata write that would change a project's site slug.
 *
 * The slug is the site's public id (CDN paths, site tokens, asset URLs), so it
 * is set once — by the flow that creates or imports the site — and never
 * changes. `project` is the stored project, with `metadata.siteSlug` already
 * overlaid from its `org_sites` link.
 *
 * Allowed: no `siteSlug` key (it is kept), the same value (forms send the whole
 * metadata back), and an empty value on a project that has none. For a legacy
 * project whose slug is still its title, writing that same slug is no change.
 */
export function assertSiteSlugUnchanged(
  project: {
    title?: string | null;
    metadata?: { siteSlug?: string | null } | null;
  },
  metadata: Record<string, unknown> | null | undefined,
): void {
  if (!metadata || !("siteSlug" in metadata)) return;
  const incoming = normalize(metadata.siteSlug);
  const current = normalize(project.metadata?.siteSlug);
  if (current) {
    if (incoming !== current) throw new SiteSlugImmutableError();
    return;
  }
  if (!incoming) return;
  const fromTitle = normalize(project.title);
  if (isValidSiteSlug(fromTitle) && incoming === fromTitle) return;
  throw new SiteSlugImmutableError();
}
