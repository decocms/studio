import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { withDefaultsForNew } from "@/components/sections-editor/schema-defaults";
import type { SectionCatalogEntry } from "@/components/sections-editor/section-catalog";
import { nextUniqueBlockKey } from "./content-mutations";

/**
 * Build a new saved global section block from a catalog entry. With `meta`,
 * it starts with its `@default`s (for a project whose forms won't fill them).
 */
export function buildSectionBlockFromCatalogEntry(
  entry: SectionCatalogEntry,
  decofile: Record<string, unknown>,
  meta?: LiveMeta,
): { blockKey: string; data: Record<string, unknown> } {
  const baseLabel = (entry.title || entry.resolveType.split("/").pop() || "")
    .replace(/\.(tsx?|jsx?)$/, "")
    .replace(/[^A-Za-z0-9_-]/g, "");
  const safeBase =
    /^[A-Za-z]/.test(baseLabel) && baseLabel.length > 0 ? baseLabel : "Section";
  const blockKey = nextUniqueBlockKey(decofile, safeBase);
  return {
    blockKey,
    data: withDefaultsForNew<Record<string, unknown>>(
      undefined,
      { __resolveType: entry.resolveType, name: blockKey },
      meta,
    ),
  };
}
