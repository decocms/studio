import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

/** The single section resolveType all SchemaFormHarness fixtures live under. */
export const TEST_RESOLVE_TYPE = "site/sections/Test.tsx";

/**
 * Build a LiveMeta whose only block is the section schema under test, mirroring
 * the `metaWithSchema` helper used by the co-located resolve-schema unit tests.
 * `defs` populates the global `schema.$defs` for $ref resolution.
 */
function metaWithSchema(
  blockSchema: Record<string, unknown>,
  defs?: Record<string, unknown>,
): LiveMeta {
  return {
    manifest: {
      blocks: { sections: { [TEST_RESOLVE_TYPE]: blockSchema } },
    },
    schema: defs ? { $defs: defs } : {},
  };
}

/** Shorthand: a section schema with the given object `properties`. */
export function sectionWithProps(
  properties: Record<string, unknown>,
  defs?: Record<string, unknown>,
): LiveMeta {
  return metaWithSchema({ type: "object", properties }, defs);
}

/** Shorthand: a section schema with `properties` and a `required` name list. */
export function sectionWithRequired(
  properties: Record<string, unknown>,
  required: string[],
): LiveMeta {
  return metaWithSchema({ type: "object", properties, required });
}
