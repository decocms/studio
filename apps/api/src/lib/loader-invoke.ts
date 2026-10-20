/** Deco loader/action resolveType — alphanumeric path segments only. */
const RESOLVE_TYPE_PATTERN = /^[\w./@-]+$/;

export function isValidLoaderResolveType(resolveType: string): boolean {
  if (!resolveType || resolveType.includes("..")) return false;
  return RESOLVE_TYPE_PATTERN.test(resolveType);
}

/**
 * The read-only VTEX loaders the sandbox-less catalog-invoke route may proxy to
 * a site's public deco runtime. This is an allowlist, not a pattern: unlike the
 * sandbox `preview-invoke` (which proxies any resolveType to the user's OWN
 * sandbox), catalog-invoke can target the site's PRODUCTION runtime, so it is
 * held to exactly the two product-discovery loaders the blog ProductShelf
 * picker needs. Mirrors the web picker's `VTEX_*_RESOLVE_TYPE` constants in
 * `apps/web/.../blog/blocks/product-picker-source.ts` — keep the two in sync.
 */
export const CATALOG_LOADER_RESOLVE_TYPES = [
  "vtex/loaders/intelligentSearch/productList.ts",
  "vtex/loaders/categories/tree.ts",
] as const;

export function isCatalogLoaderResolveType(resolveType: string): boolean {
  return (CATALOG_LOADER_RESOLVE_TYPES as readonly string[]).includes(
    resolveType,
  );
}

/**
 * Split a block-ref (`{ __resolveType, ...props }`) into the single-invoke
 * target Deco expects: POST /deco/invoke/<resolveType> with the loader props
 * as the JSON body.
 *
 * Posting to /deco/invoke without a path key is batch mode and treats each
 * top-level field as a separate handler name.
 */
export function parseLoaderInvokeRequest(body: Record<string, unknown>): {
  resolveType: string;
  payload: Record<string, unknown>;
} | null {
  const resolveType =
    typeof body.__resolveType === "string" ? body.__resolveType : null;
  if (!resolveType || !isValidLoaderResolveType(resolveType)) return null;

  const { __resolveType: _, ...rest } = body;
  return { resolveType, payload: rest };
}

/**
 * The resolveType goes RAW in the path (slashes intact) — the deco runtime
 * routes `/deco/invoke/*` on the un-decoded path, so a `%2F`-encoded key never
 * matches a loader. Callers must validate with {@link isValidLoaderResolveType}
 * first (the pattern excludes `..`, spaces, and reserved URL characters).
 */
export function buildLoaderInvokeUrl(
  previewBaseUrl: string,
  resolveType: string,
): string {
  const base = previewBaseUrl.replace(/\/+$/, "");
  return `${base}/deco/invoke/${resolveType}`;
}
