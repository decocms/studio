import type { FileConfigInfo } from "@/hooks/use-file-configs";

/**
 * Find the file config that owns a site slug so the CMS picker can lock to it.
 * Matches managed tenancy siteSlug and BYOB bucket naming conventions.
 */
export function matchSiteSlugConfig(
  configs: FileConfigInfo[],
  siteSlug: string | null | undefined,
): FileConfigInfo | null {
  if (!siteSlug) return null;

  const slug = siteSlug.toLowerCase();
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
