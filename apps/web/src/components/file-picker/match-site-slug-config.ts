import { slugify } from "@decocms/shared/utils/slugify";
import type { FileConfigInfo } from "@/hooks/use-file-configs";

/**
 * Find the file config that owns a site slug so the CMS picker can lock to it.
 * Matches managed tenancy siteSlug and BYOB bucket naming conventions.
 *
 * Callers now pass the project's free-form display name (`entity.title`), not
 * a guaranteed-slug value (see #6296) — slugify it first so a title like
 * "Deco CMS" still matches a `deco-assets-decocms` bucket instead of silently
 * missing because of the space. A no-op for values that were already slugs.
 */
export function matchSiteSlugConfig(
  configs: FileConfigInfo[],
  siteSlug: string | null | undefined,
): FileConfigInfo | null {
  if (!siteSlug) return null;

  const slug = slugify(siteSlug);
  if (!slug) return null;
  return (
    configs.find((config) => {
      const bucket = config.bucket.toLowerCase();
      return (
        config.siteSlug?.toLowerCase() === slug ||
        bucket === slug ||
        bucket === `deco-assets-${slug}`
      );
    }) ?? null
  );
}
