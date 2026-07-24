import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "../resolve-schema";

/**
 * Cache resolveSchema() results per (meta, resolveType) pair. Keyed on the
 * `meta` instance (WeakMap, so a stale meta's entries GC with it) rather than
 * on `resolveType` alone — built-in matcher/loader resolveType strings (e.g.
 * the standard device/user matchers) are shared verbatim across every deco
 * site, so a resolveType-only cache would return one site's schema for
 * another site's block the moment the user switches virtual MCPs without a
 * full page reload.
 */
const schemaCache = new WeakMap<LiveMeta, Map<string, SchemaProperty | null>>();

export function cachedResolveSchema(
  resolveType: string,
  meta: LiveMeta,
): SchemaProperty | null {
  let byResolveType = schemaCache.get(meta);
  if (!byResolveType) {
    byResolveType = new Map();
    schemaCache.set(meta, byResolveType);
  }
  let result = byResolveType.get(resolveType);
  if (result === undefined) {
    result = resolveSchema(resolveType, meta);
    byResolveType.set(resolveType, result);
  }
  return result;
}
