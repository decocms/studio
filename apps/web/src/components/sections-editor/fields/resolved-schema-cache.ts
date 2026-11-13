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

const filledCache = new WeakMap<
  SchemaProperty,
  WeakMap<SchemaProperty, SchemaProperty>
>();

/**
 * `schema` with the `type`-discriminated union branches that the depth cap left
 * without a schema taken from `fallback`, the same type built shallower. Such
 * branches have no lazy resolution, so without this the branch select draws no
 * fields. Only empty branches are filled: what `schema` already has is kept.
 */
export function fillDepthCappedBranches(
  schema: SchemaProperty,
  fallback: SchemaProperty | undefined,
): SchemaProperty {
  if (!fallback || schema === fallback) return schema;
  let byFallback = filledCache.get(schema);
  let filled = byFallback?.get(fallback);
  if (!filled) {
    filled = fillBranches(schema, fallback, 0);
    if (!byFallback) {
      byFallback = new WeakMap();
      filledCache.set(schema, byFallback);
    }
    byFallback.set(fallback, filled);
  }
  return filled;
}

// resolveSchema() output is acyclic; the cap only bounds a malformed tree.
const MAX_FILL_DEPTH = 64;

function fillBranches(
  schema: SchemaProperty,
  fallback: SchemaProperty,
  depth: number,
): SchemaProperty {
  if (depth > MAX_FILL_DEPTH) return schema;
  let changed = false;
  const fillChild = (
    child: SchemaProperty | undefined,
    other: SchemaProperty | undefined,
  ) => {
    if (!child || !other || child === other) return child;
    const next = fillBranches(child, other, depth + 1);
    if (next !== child) changed = true;
    return next;
  };

  const anyOfRefs = schema.anyOfRefs?.map((ref) => {
    const other = fallback.anyOfRefs?.find(
      (r) => r.resolveType === ref.resolveType,
    );
    if (!other?.schema) return ref;
    if (!ref.schema) {
      if (!schema.discriminatorKey) return ref;
      changed = true;
      return { ...ref, schema: other.schema };
    }
    const next = fillChild(ref.schema, other.schema);
    return next === ref.schema ? ref : { ...ref, schema: next };
  });
  const properties = schema.properties
    ? Object.fromEntries(
        Object.entries(schema.properties).map(([key, prop]) => [
          key,
          fillChild(prop, fallback.properties?.[key]) ?? prop,
        ]),
      )
    : undefined;
  const items = fillChild(schema.items, fallback.items);
  const inlineUnionBranches = schema.inlineUnionBranches?.map(
    (branch, index) => {
      const other = fallback.inlineUnionBranches?.[index];
      if (other?.title !== branch.title) return branch;
      const next = fillChild(branch.schema, other.schema);
      return next === branch.schema ? branch : { ...branch, schema: next };
    },
  );

  if (!changed) return schema;
  return {
    ...schema,
    ...(anyOfRefs && { anyOfRefs }),
    ...(properties && { properties }),
    ...(items && { items }),
    ...(inlineUnionBranches && { inlineUnionBranches }),
  };
}
