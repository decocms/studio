import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";
import type { SchemaProperty } from "./resolve-schema";

/** Admin `SEO_BASE_SCHEMA` — General pages only. */
export const GENERAL_SEO_FIELD_KEYS = [
  "type",
  "title",
  "description",
  "canonical",
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

export function getSeoFormMode(resolveType: string): SeoFormMode {
  if (
    resolveType === DEFAULT_SEO_RESOLVE_TYPE ||
    /\/Seo\/SeoV2\.tsx$/i.test(resolveType)
  ) {
    return "general";
  }
  if (/\/Seo\/SeoPDP/i.test(resolveType)) return "pdp";
  if (/\/Seo\/SeoPLP/i.test(resolveType)) return "plp";
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
): SchemaProperty {
  const keys = fieldKeysForMode(getSeoFormMode(resolveType));
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
