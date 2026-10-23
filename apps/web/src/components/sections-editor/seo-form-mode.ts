import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";
import type { SchemaProperty } from "./resolve-schema";

/** Admin `SEO_BASE_SCHEMA` — General pages only. */
export const GENERAL_SEO_FIELD_KEYS = [
  "type",
  "title",
  "description",
  "canonical",
  "noIndexing",
  "favicon",
  "image",
  "themeColor",
] as const;

/** Product details (PDP) — matches commerce SeoPDP* props. */
export const PDP_SEO_FIELD_KEYS = [
  "jsonLD",
  "omitVariants",
  "title",
  "description",
  "noIndexing",
  "ignoreStructuredData",
] as const;

/** Product listing (PLP) — matches commerce SeoPLP* props. */
export const PLP_SEO_FIELD_KEYS = [
  "jsonLD",
  "title",
  "description",
  "noIndexing",
  "configJsonLD",
] as const;

export type SeoFormMode = "general" | "pdp" | "plp" | "full";

/** v7 SEO section file names (`…/Seo/SeoV2.tsx`, `…/Seo/SeoPDPV2.tsx`). */
function v7SeoFormMode(resolveType: string): SeoFormMode | null {
  if (
    resolveType === DEFAULT_SEO_RESOLVE_TYPE ||
    /\/Seo\/SeoV2\.tsx$/i.test(resolveType)
  ) {
    return "general";
  }
  if (/\/Seo\/SeoPDP/i.test(resolveType)) return "pdp";
  if (/\/Seo\/SeoPLP/i.test(resolveType)) return "plp";
  return null;
}

/** A commerce hint in a short block name (`productSeo`, `seoPlp`, …). */
function nameHint(resolveType: string): "pdp" | "plp" | null {
  const name = resolveType.toLowerCase();
  if (/pdp|product/.test(name)) return "pdp";
  if (/plp|listing|categor|search/.test(name)) return "plp";
  return null;
}

/** Whether every field of the form is one of `keys` (and there is one). */
function fieldsWithin(
  schema: SchemaProperty,
  keys: readonly string[],
): boolean {
  const fields = Object.keys(schema.properties ?? {}).filter(
    (k) => k !== "__resolveType",
  );
  return fields.length > 0 && fields.every((k) => keys.includes(k));
}

/**
 * The form layout for an SEO type. v7 file names keep admin's layouts (other
 * file paths, the full form). Off a Blocks v8 site (`v8` false) every other
 * type gets the full form, as before. On v8, short names are read from the
 * schema: the General layout (with its "Use default" toggles) when every field
 * is a general SEO field, the product/listing layout when its name says so and
 * every field fits, and the full form otherwise — a layout never hides one of
 * its fields. With no schema, the name alone decides.
 */
export function getSeoFormMode(
  resolveType: string,
  schema?: SchemaProperty | null,
  v8 = false,
): SeoFormMode {
  const v7 = v7SeoFormMode(resolveType);
  if (v7) return v7;
  if (!v8) return "full";
  // Any other file path is a v7 type admin had no layout for.
  if (resolveType.includes("/")) return "full";
  const hint = nameHint(resolveType);
  if (!schema) return hint ?? "full";
  if (hint === "pdp" && fieldsWithin(schema, PDP_SEO_FIELD_KEYS)) return "pdp";
  if (hint === "plp" && fieldsWithin(schema, PLP_SEO_FIELD_KEYS)) return "plp";
  if (fieldsWithin(schema, GENERAL_SEO_FIELD_KEYS)) return "general";
  return "full";
}

function fieldKeysForMode(mode: SeoFormMode): readonly string[] | null {
  switch (mode) {
    case "general":
      return GENERAL_SEO_FIELD_KEYS;
    case "pdp":
      return PDP_SEO_FIELD_KEYS;
    case "plp":
      return PLP_SEO_FIELD_KEYS;
    default:
      return null;
  }
}

/** Picks the property subset shown in admin per SEO type. */
export function filterSeoSchema(
  schema: SchemaProperty,
  resolveType: string,
  /** A Blocks v8 site (see `getSeoFormMode`). */
  v8 = false,
): SchemaProperty {
  const keys = fieldKeysForMode(getSeoFormMode(resolveType, schema, v8));
  if (!keys || !schema.properties) return schema;

  const properties: Record<string, SchemaProperty> = {};
  for (const key of keys) {
    const prop = schema.properties[key];
    if (prop) properties[key] = prop;
  }
  return { ...schema, properties };
}

export function generalSeoFieldsWithDefaultToggle(): readonly string[] {
  return GENERAL_SEO_FIELD_KEYS.filter((k) => k !== "type");
}
