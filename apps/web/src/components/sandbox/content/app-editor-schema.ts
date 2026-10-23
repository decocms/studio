import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "@/components/sections-editor/resolve-schema";

/** Omit top-level fields unless that would leave nothing to edit (e.g. site apps whose schema is only `seo`). */
export function applySchemaExcludeFields(
  baseSchema: SchemaProperty | null,
  excludeFields?: readonly string[],
): SchemaProperty | null {
  if (!baseSchema || !excludeFields?.length) return baseSchema;

  const filteredProperties = Object.fromEntries(
    Object.entries(baseSchema.properties ?? {}).filter(
      ([key]) => !excludeFields.includes(key),
    ),
  );

  if (Object.keys(filteredProperties).length > 0) {
    return { ...baseSchema, properties: filteredProperties };
  }

  return baseSchema;
}

/** Resolved form schema for AppEditor (live meta + optional field exclusions). */
export function resolveAppEditorSchema(
  resolveType: string | undefined,
  meta: LiveMeta,
  excludeFields?: readonly string[],
): SchemaProperty | null {
  if (typeof resolveType !== "string") return null;
  return applySchemaExcludeFields(
    resolveSchema(resolveType, meta),
    excludeFields,
  );
}

export function hasEditableAppEditorSchema(
  resolveType: string | undefined,
  meta: LiveMeta | undefined,
  excludeFields?: readonly string[],
): boolean {
  if (!meta || typeof resolveType !== "string") return false;
  const schema = resolveAppEditorSchema(resolveType, meta, excludeFields);
  return !!schema && Object.keys(schema.properties ?? {}).length > 0;
}

/**
 * Whether the schema comes from a TanStack storefront (`@decocms/start` v6
 * tags it `framework: "tanstack-start"`; v8 declares `blocksMajor: 8`). Neither
 * renders an app module's `preview` export: v6 answers "Unknown section" and
 * v8's worker 404s `/live/*`.
 */
export function isTanstackMeta(meta: LiveMeta): boolean {
  return (
    ("framework" in meta && meta.framework === "tanstack-start") ||
    ("blocksMajor" in meta && meta.blocksMajor === 8)
  );
}
