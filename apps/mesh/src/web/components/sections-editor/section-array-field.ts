import type { SchemaProperty } from "./resolve-schema";
import { isPageMultivariateSectionArrayField } from "./page-variants";
import { SECTION_MULTIVARIATE_RESOLVE_TYPE } from "./section-types";

/** True when an array field holds page/global section entries (block-ref items). */
export function isSectionArrayField(schema: SchemaProperty): boolean {
  if (isPageMultivariateSectionArrayField(schema)) return true;

  const items = schema.type === "array" ? schema.items : undefined;
  if (!items || items.type !== "block-ref" || !items.anyOfRefs?.length) {
    return false;
  }

  return items.anyOfRefs.some((ref) => {
    const rt = ref.resolveType;
    return (
      rt.includes("/sections/") ||
      rt.includes("multivariate/section") ||
      rt === SECTION_MULTIVARIATE_RESOLVE_TYPE
    );
  });
}
