import {
  detectBlockRefType,
  withBranchDiscriminator,
} from "./block-ref-field-utils";
import { isManifestBlockResolveType } from "./block-type-utils";
import { cachedResolveSchema } from "./fields/resolved-schema-cache";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";

type PlainObject = Record<string, unknown>;

/**
 * `value` with every missing explicit `@default` filled in, as the old RJSF
 * admin did when a form opened: through nested objects, array items, inline
 * union branches, and nested blocks (`__resolveType` values, whose schema
 * comes from `meta`).
 * Explicit values, including `false`, `""` and `0`, are kept. Returns the same
 * reference when nothing is missing.
 */
export function applySchemaDefaults(
  schema: SchemaProperty | null | undefined,
  value: unknown,
  meta?: LiveMeta,
): unknown {
  return isPlainObject(value) ? seedShape(schema, value, meta) : value;
}

/** An inline union is filled from the branch its const discriminators select. */
function seedShape(
  schema: SchemaProperty | null | undefined,
  obj: PlainObject,
  meta: LiveMeta | undefined,
): PlainObject {
  if (schema?.type !== "inline-union") return seedObject(schema, obj, meta);
  const branch = schema.inlineUnionBranches?.find(
    (b) =>
      b.discriminators &&
      Object.entries(b.discriminators).every(([k, v]) => obj[k] === v),
  );
  return seedObject(branch?.schema, obj, meta);
}

function seedObject(
  schema: SchemaProperty | null | undefined,
  obj: PlainObject,
  meta: LiveMeta | undefined,
): PlainObject {
  let next: PlainObject | null = null;
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    if (!prop || key.startsWith("__") || key === "@type") continue;
    const current = obj[key];
    const seeded =
      current === undefined
        ? missingValue(prop, meta)
        : seedValue(prop, current, meta);
    if (seeded !== current) (next ??= { ...obj })[key] = seeded;
  }
  return next ?? obj;
}

function missingValue(
  prop: SchemaProperty,
  meta: LiveMeta | undefined,
): unknown {
  if (prop.default !== undefined && prop.default !== null) {
    return seedValue(prop, structuredClone(prop.default), meta);
  }
  if (prop.type === "object" && prop.properties) {
    const nested = seedObject(prop, {}, meta);
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  return undefined;
}

function seedValue(
  schema: SchemaProperty | null | undefined,
  value: unknown,
  meta: LiveMeta | undefined,
): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => seedValue(schema?.items, item, meta));
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (!isPlainObject(value)) return value;
  const resolveType = value.__resolveType;
  if (typeof resolveType === "string") {
    // Saved-block references stay untouched: props beside them would override the saved block.
    return meta && isManifestBlockResolveType(meta, resolveType)
      ? seedShape(cachedResolveSchema(resolveType, meta), value, meta)
      : value;
  }
  if (schema?.type === "block-ref" && schema.discriminatorKey) {
    return seedDiscriminator(schema, schema.discriminatorKey, value);
  }
  return schema?.type === "object" || schema?.type === "inline-union"
    ? seedShape(schema, value, meta)
    : value;
}

/**
 * A `type`-discriminated union value only gets the discriminator of the branch
 * the editor shows, when it has none. Its other `@default`s stay unwritten:
 * this path never seeded them, and filling them would rewrite every saved
 * value of such a union on open.
 */
function seedDiscriminator(
  schema: SchemaProperty,
  discriminatorKey: string,
  obj: PlainObject,
): PlainObject {
  if (obj[discriminatorKey] !== undefined) return obj;
  const refs = schema.anyOfRefs ?? [];
  const shown = detectBlockRefType(obj, refs);
  return withBranchDiscriminator(
    obj,
    discriminatorKey,
    refs.find((r) => r.resolveType === shown),
  ) as PlainObject;
}

/**
 * A value being created — a new section, array item, branch or option — with
 * its `@default`s filled in the same way {@link applySchemaDefaults} fills a
 * block. Unlike an existing value, it also starts from its own object
 * `default` and, as a union, from its branch's defaults. Saved-block
 * references stay as they are.
 */
export function withDefaultsForNew<T>(
  schema: SchemaProperty | null | undefined,
  value: T,
  meta?: LiveMeta,
): T {
  const base =
    isPlainObject(value) && isPlainObject(schema?.default)
      ? { ...structuredClone(schema.default), ...value }
      : value;
  const seeded = seedValue(schema, base, meta);
  const branch = createdBranchSchema(schema, seeded);
  // Seeding only adds missing keys, so the value keeps its shape.
  return (
    branch && isPlainObject(seeded) ? seedShape(branch, seeded, meta) : seeded
  ) as T;
}

/** The branch a new union value (no `__resolveType`) belongs to. */
function createdBranchSchema(
  schema: SchemaProperty | null | undefined,
  value: unknown,
): SchemaProperty | undefined {
  if (schema?.type !== "block-ref" || !isPlainObject(value)) return undefined;
  if (typeof value.__resolveType === "string") return undefined;
  const refs = schema.anyOfRefs ?? [];
  const shown = detectBlockRefType(value, refs);
  return refs.find((r) => r.resolveType === shown)?.schema;
}

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
