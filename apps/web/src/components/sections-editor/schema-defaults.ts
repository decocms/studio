import { canonicalBlockJson } from "@decocms/shared/decofile";
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
 * block. Saved-block references stay as they are.
 */
export function withDefaultsForNew(
  schema: SchemaProperty | null | undefined,
  value: unknown,
  meta?: LiveMeta,
): unknown {
  return seedValue(schema, value, meta);
}

/**
 * What a form built from `seeded` (`applySchemaDefaults(schema, value, meta)`)
 * emitted, reduced to `value` plus the user's own changes. A default the form
 * only showed is dropped again — including an object it materialized for its
 * defaulted children — so editing one field of an existing block never writes
 * defaults into the others. What the user creates (an array item, a switched
 * block, an absent object they edit) is kept as emitted, defaults included.
 * Returns `value` itself when nothing changed.
 */
export function unseedSchemaDefaults(
  schema: SchemaProperty | null | undefined,
  value: unknown,
  seeded: unknown,
  emitted: unknown,
  meta?: LiveMeta,
): unknown {
  if (emitted === seeded) return value;
  const out =
    isPlainObject(emitted) && isPlainObject(seeded)
      ? unseedShape(schema, value, seeded, emitted, meta)
      : emitted;
  return same(out, value) ? value : out;
}

function unseedShape(
  schema: SchemaProperty | null | undefined,
  stored: unknown,
  seeded: PlainObject,
  emitted: PlainObject,
  meta: LiveMeta | undefined,
): PlainObject {
  if (schema?.type !== "inline-union") {
    return unseedObject(schema, stored, seeded, emitted, meta);
  }
  const branch = schema.inlineUnionBranches?.find(
    (b) =>
      b.discriminators &&
      Object.entries(b.discriminators).every(([k, v]) => emitted[k] === v),
  );
  return unseedObject(branch?.schema, stored, seeded, emitted, meta);
}

function unseedObject(
  schema: SchemaProperty | null | undefined,
  stored: unknown,
  seeded: PlainObject,
  emitted: PlainObject,
  meta: LiveMeta | undefined,
): PlainObject {
  const base = isPlainObject(stored) ? stored : {};
  const out: PlainObject = {};
  for (const [key, next] of Object.entries(emitted)) {
    const shown = seeded[key];
    const had = base[key];
    const prop = schema?.properties?.[key];
    if (next === shown) {
      // Untouched: what was stored, without what seeding added inside it.
      if (had !== undefined) out[key] = had;
      continue;
    }
    if (had !== undefined || shown === undefined) {
      out[key] =
        had === undefined ? next : unseedValue(prop, had, shown, next, meta);
      continue;
    }
    // Only shown as a default (or an object seeding materialized for its
    // defaulted children): unless the user changed it, it stays unwritten. A
    // change creates it, so it is written whole, with its defaults.
    if (!same(next, shown)) out[key] = next;
  }
  return out;
}

function unseedValue(
  schema: SchemaProperty | null | undefined,
  stored: unknown,
  seeded: unknown,
  emitted: unknown,
  meta: LiveMeta | undefined,
): unknown {
  if (emitted === seeded) return stored;
  if (Array.isArray(emitted)) {
    return Array.isArray(seeded)
      ? unseedArray(schema?.items, stored, seeded, emitted, meta)
      : emitted;
  }
  if (!isPlainObject(emitted) || !isPlainObject(seeded)) return emitted;
  const resolveType = emitted.__resolveType;
  if (typeof resolveType === "string") {
    const switched =
      seeded.__resolveType !== resolveType ||
      (isPlainObject(stored) && stored.__resolveType !== resolveType);
    if (switched || !meta || !isManifestBlockResolveType(meta, resolveType)) {
      return emitted;
    }
    return unseedShape(
      cachedResolveSchema(resolveType, meta),
      stored,
      seeded,
      emitted,
      meta,
    );
  }
  return schema?.type === "object" || schema?.type === "inline-union"
    ? unseedShape(schema, stored, seeded, emitted, meta)
    : unseedObject(undefined, stored, seeded, emitted, meta);
}

/** Items are matched to the stored ones by reference (moves and removals keep it), else by position. */
function unseedArray(
  itemSchema: SchemaProperty | null | undefined,
  stored: unknown,
  seeded: unknown[],
  emitted: unknown[],
  meta: LiveMeta | undefined,
): unknown[] {
  const before = Array.isArray(stored) ? stored : [];
  return emitted.map((item, i) => {
    let j = seeded.indexOf(item);
    if (j === -1 && emitted.length === seeded.length) j = i;
    if (j === -1 || j >= before.length) return item;
    return item === seeded[j]
      ? before[j]
      : unseedValue(itemSchema, before[j], seeded[j], item, meta);
  });
}

function same(a: unknown, b: unknown): boolean {
  return canonicalBlockJson(a) === canonicalBlockJson(b);
}

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
