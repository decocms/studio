/** Deco loader/action resolveType — alphanumeric path segments only. */
const RESOLVE_TYPE_PATTERN = /^[\w./@-]+$/;

export function isValidLoaderResolveType(resolveType: string): boolean {
  if (!resolveType || resolveType.includes("..")) return false;
  return RESOLVE_TYPE_PATTERN.test(resolveType);
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
