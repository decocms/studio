import type { FileConfigInfo } from "@/hooks/use-file-configs";

/**
 * Prefer the project’s explicit storage. Otherwise match managed tenancy
 * siteSlug and legacy bucket naming conventions. A missing explicit config
 * must not silently redirect uploads to a different bucket.
 */
export function matchSiteSlugConfig(
  configs: FileConfigInfo[],
  siteSlug: string | null | undefined,
  explicitConfigId?: string | null,
): FileConfigInfo | null {
  if (explicitConfigId) {
    return configs.find((config) => config.id === explicitConfigId) ?? null;
  }
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
