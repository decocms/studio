import { DENO_SITE_APPS } from "./registry-deno";
import { TANSTACK_SITE_APPS } from "./registry-tanstack";
import type { SiteAppRegistryEntry, SiteTechnology } from "./types";

export { siteAppBlockKey, siteAppResolveType } from "./block";
export {
  makeInstallAppPatches,
  SiteAppInstallError,
  type InstallAppPatches,
  type MakeInstallAppPatchesInput,
  type SiteAppFilePatch,
} from "./install-patches";
export { DENO_SITE_APPS } from "./registry-deno";
export { TANSTACK_SITE_APPS } from "./registry-tanstack";
export {
  decocmsVersionRange,
  detectSiteTechnology,
  siteTechnologyFromFramework,
  siteTechnologyFromPackageManager,
  type DetectedSiteTechnology,
} from "./technology";
export type {
  SiteAppPackage,
  SiteAppRegistryEntry,
  SiteTechnology,
} from "./types";

/** The apps installable on a site built with `technology`. */
export function siteAppRegistry(
  technology: SiteTechnology,
): readonly SiteAppRegistryEntry[] {
  return technology === "deno" ? DENO_SITE_APPS : TANSTACK_SITE_APPS;
}

export function findSiteApp(
  technology: SiteTechnology,
  blockKey: string,
): SiteAppRegistryEntry | null {
  return (
    siteAppRegistry(technology).find((app) => app.blockKey === blockKey) ?? null
  );
}

/**
 * An app's catalogue entry by block key, searching BOTH stacks. For display
 * only: a Deno-era app on a TanStack site stays listed and editable but is
 * not installable there, and it still deserves its name and logo.
 */
export function findSiteAppAnyStack(
  blockKey: string,
): SiteAppRegistryEntry | null {
  return (
    findSiteApp("tanstack", blockKey) ?? findSiteApp("deno", blockKey) ?? null
  );
}
