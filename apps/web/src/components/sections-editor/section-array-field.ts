import type { SchemaProperty } from "./resolve-schema";
import { isPageMultivariateSectionArrayField } from "./page-variants";
import { SECTION_MULTIVARIATE_RESOLVE_TYPE } from "./section-types";

function sectionRefResolveType(resolveType: string): boolean {
  return (
    resolveType.includes("/sections/") ||
    resolveType.includes("multivariate/section") ||
    resolveType === SECTION_MULTIVARIATE_RESOLVE_TYPE
  );
}

function itemsLookLikeSections(items: SchemaProperty): boolean {
  if (items.type === "block-ref" && items.anyOfRefs?.length) {
    return items.anyOfRefs.some((ref) =>
      sectionRefResolveType(ref.resolveType),
    );
  }

  if (items.anyOfRefs?.length) {
    return items.anyOfRefs.some((ref) =>
      sectionRefResolveType(ref.resolveType),
    );
  }

  const rtProp = items.properties?.__resolveType;
  if (rtProp?.type === "block-ref" && rtProp.anyOfRefs?.length) {
    return rtProp.anyOfRefs.some((ref) =>
      sectionRefResolveType(ref.resolveType),
    );
  }

  return false;
}

/**
 * True when a single (non-array) field is a `Section` slot — deco's generic
 * Section type, which accepts any section module or saved section block. The
 * schema names only a handful of those, so such a field is picked from the
 * section catalog rather than from its own branches.
 */
export function isSectionBlockRefField(schema: SchemaProperty): boolean {
  if (schema.type !== "block-ref" || !schema.anyOfRefs?.length) return false;
  return schema.anyOfRefs.some((ref) => sectionRefResolveType(ref.resolveType));
}

/** True when an array field holds page/global section entries. */
export function isSectionArrayField(
  schema: SchemaProperty,
  fieldKey?: string,
): boolean {
  if (fieldKey === "global" || fieldKey === "sections") return true;
  if (isPageMultivariateSectionArrayField(schema)) return true;

  const items = schema.type === "array" ? schema.items : undefined;
  if (!items) return false;

  return itemsLookLikeSections(items);
}
