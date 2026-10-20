import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

/**
 * The CMS settings of a Blocks (v8) site: preview hosts, telemetry and
 * analytics, in one optional saved block. Its name and type are the only two
 * things the editor knows about it; the form comes from the schema, which
 * describes the type. A site whose framework has no such type (published
 * `@decocms/blocks` before it existed, or a v7 site) gets no Settings entry.
 */
export const CMS_SETTINGS_BLOCK_KEY = "CMS";
export const CMS_SETTINGS_RESOLVE_TYPE = "cms-settings";

/** Whether the schema describes the `cms-settings` block type. */
export function hasCmsSettingsType(meta: LiveMeta | undefined): boolean {
  const groups = meta?.manifest?.blocks ?? {};
  return Object.values(groups).some(
    (group) => !!group && Object.hasOwn(group, CMS_SETTINGS_RESOLVE_TYPE),
  );
}

export type CmsSettingsBlock =
  /** No `CMS` block yet: every setting is at its default; the first save creates it. */
  | { kind: "absent"; block: Record<string, unknown> }
  | { kind: "saved"; block: Record<string, unknown> }
  /** A block named `CMS` of another type (`deco check` warns about it). */
  | { kind: "conflict"; resolveType: string };

/** The `CMS` block to edit, or a stand-in holding only its type when absent. */
export function readCmsSettingsBlock(
  decofile: Record<string, unknown>,
): CmsSettingsBlock {
  const value = Object.hasOwn(decofile, CMS_SETTINGS_BLOCK_KEY)
    ? decofile[CMS_SETTINGS_BLOCK_KEY]
    : undefined;
  if (value === undefined || value === null) {
    return {
      kind: "absent",
      block: { __resolveType: CMS_SETTINGS_RESOLVE_TYPE },
    };
  }
  const resolveType =
    typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).__resolveType
      : undefined;
  if (resolveType !== CMS_SETTINGS_RESOLVE_TYPE) {
    return {
      kind: "conflict",
      resolveType: typeof resolveType === "string" ? resolveType : "",
    };
  }
  return { kind: "saved", block: value as Record<string, unknown> };
}
