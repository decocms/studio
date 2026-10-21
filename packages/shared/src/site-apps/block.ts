/**
 * The decofile identity of an installed site app. Deno and TanStack agree on
 * both: the block key is what `autoconfigApps` looks a TanStack app up by, and
 * the resolveType is what the Deno resolver imports — a site migrated from
 * Fresh keeps carrying it, and the CMS editor matches schemas against it.
 */

export function siteAppBlockKey(vendor: string, app: string): string {
  return `${vendor}-${app}`;
}

export function siteAppResolveType(vendor: string, app: string): string {
  return `site/apps/${vendor}/${app}.ts`;
}
