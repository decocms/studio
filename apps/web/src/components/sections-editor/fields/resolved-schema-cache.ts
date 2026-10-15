import {
  resolveSchema,
  resolveSchemaRef,
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

const expandedCache = new WeakMap<SchemaProperty, SchemaProperty>();

/**
 * Fill in the nested schema resolveSchema() skipped at a recursive type's
 * re-entry, one level at a time as the form reaches it. Keyed on the node, so
 * a re-render gets the same object back.
 */
export function expandRecursiveSchema(
  schema: SchemaProperty,
  meta: LiveMeta | undefined,
): SchemaProperty;
export function expandRecursiveSchema(
  schema: SchemaProperty | undefined,
  meta: LiveMeta | undefined,
): SchemaProperty | undefined;
export function expandRecursiveSchema(
  schema: SchemaProperty | undefined,
  meta: LiveMeta | undefined,
): SchemaProperty | undefined {
  if (!schema?.recursiveRef || !meta) return schema;
  let expanded = expandedCache.get(schema);
  if (!expanded) {
    const { properties, required, items } = resolveSchemaRef(
      schema.recursiveRef,
      meta,
    );
    expanded = {
      ...schema,
      properties,
      required,
      items,
      recursiveRef: undefined,
    };
    expandedCache.set(schema, expanded);
  }
  return expanded;
}
