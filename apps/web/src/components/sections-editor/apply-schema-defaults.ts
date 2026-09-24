import type { SchemaProperty } from "./resolve-schema";

/**
 * Materialize a schema's explicit `@default` values into the saved config.
 *
 * The Studio form renders a field left at its default as that default (see
 * `defaultForType`/`effectiveValue` in `schema-form.tsx`), but only fields the
 * user actually touches are written to the block JSON — an untouched default is
 * omitted. The deco runtime does not apply `@default` either, so the annotation
 * had no runtime effect: the editor showed a toggle "on" (`@default true`)
 * while the component received `undefined`. Seeding the default at the
 * persistence boundary keeps the saved JSON in sync with what the editor shows,
 * so `@default true` reaches the component as `true`.
 *
 * Conservative on purpose:
 * - Only fills a key that is MISSING (`undefined`). An explicit value — including
 *   an explicit `false`, `""`, or `0` the user chose — is never overwritten.
 * - Only seeds props that declare an explicit `default`; type-based zero values
 *   are left out so unset optional fields stay absent.
 * - Recurses only into plain object properties. Arrays, unions, block-ref
 *   pickers, and `__resolveType`-wrapped values (multivariate field wrappers)
 *   are left untouched so their structures aren't corrupted.
 *
 * Returns the same reference when nothing changed so callers can cheaply detect
 * a no-op.
 */
export function applySchemaDefaults(
  schema: SchemaProperty | null | undefined,
  value: unknown,
): unknown {
  if (
    !schema?.properties ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }

  const obj = value as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const draft = () => (next ??= { ...obj });

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema || key.startsWith("__") || key === "@type") continue;

    const current = obj[key];
    if (current === undefined) {
      if (propSchema.default !== undefined) {
        draft()[key] = propSchema.default;
      }
      continue;
    }

    if (isSeedablePlainObject(propSchema, current)) {
      const seeded = applySchemaDefaults(propSchema, current);
      if (seeded !== current) draft()[key] = seeded;
    }
  }

  return next ?? value;
}

/** A nested plain object whose own defaults can be seeded — not a block-ref or multivariate wrapper. */
function isSeedablePlainObject(
  propSchema: SchemaProperty,
  current: unknown,
): current is Record<string, unknown> {
  return (
    propSchema.type === "object" &&
    propSchema.properties != null &&
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    !("__resolveType" in (current as Record<string, unknown>))
  );
}
