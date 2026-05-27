import {
  isAutoPreviewBlockKey,
  isManifestSectionResolveType,
  isSavedBlockResolveType,
} from "./block-type-utils";
import { isLazyResolveType } from "./section-lazy";
import {
  resolveBlockSchemaMetadata,
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";

export interface SectionCatalogEntry {
  resolveType: string;
  title: string;
  description?: string;
  previewBlock: string;
  isSavedBlock: boolean;
}

const LIVE_PAGE_RESOLVE_TYPES = [
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
] as const;

const PAGE_BLOCK_RESOLVE_TYPES = new Set<string>(LIVE_PAGE_RESOLVE_TYPES);

/** Theme sections belong in site settings, not the page section picker. */
const EXCLUDED_SECTION_RESOLVE_TYPES = new Set([
  "site/sections/Theme/Theme.tsx",
]);

function labelFromResolveType(rt: string): string {
  const segments = rt.split("/");
  const filename = segments[segments.length - 1] ?? rt;
  return (
    filename
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || rt
  );
}

function shouldSkipSectionResolveType(resolveType: string): boolean {
  if (EXCLUDED_SECTION_RESOLVE_TYPES.has(resolveType)) return true;
  if (isLazyResolveType(resolveType)) return true;
  if (resolveType.toLowerCase().includes("preview")) return true;
  return false;
}

export function findLivePageResolveType(meta: LiveMeta): string {
  const blocks = meta.manifest?.blocks ?? {};
  for (const blockMap of Object.values(blocks)) {
    for (const resolveType of Object.keys(blockMap)) {
      if (PAGE_BLOCK_RESOLVE_TYPES.has(resolveType)) {
        return resolveType;
      }
    }
  }
  return LIVE_PAGE_RESOLVE_TYPES[0];
}

function collectAnyOfRefsFromSchema(
  schema: SchemaProperty | null | undefined,
): Array<{ resolveType: string; title: string; description?: string }> {
  if (!schema) return [];
  if (schema.anyOfRefs?.length) return schema.anyOfRefs;
  if (schema.items) return collectAnyOfRefsFromSchema(schema.items);
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) {
      const refs = collectAnyOfRefsFromSchema(child);
      if (refs.length > 0) return refs;
    }
  }
  return [];
}

function listManifestSections(meta: LiveMeta): SectionCatalogEntry[] {
  const blocks = meta.manifest?.blocks ?? {};
  const entries: SectionCatalogEntry[] = [];

  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("sections")) continue;

    for (const resolveType of Object.keys(blockMap)) {
      if (shouldSkipSectionResolveType(resolveType)) continue;

      const metadata = resolveBlockSchemaMetadata(resolveType, meta);
      entries.push({
        resolveType,
        title: metadata.title ?? labelFromResolveType(resolveType),
        description: metadata.description,
        previewBlock: resolveType,
        isSavedBlock: false,
      });
    }
  }

  return entries;
}

function listSavedSectionBlocks(
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): SectionCatalogEntry[] {
  const entries: SectionCatalogEntry[] = [];

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (isAutoPreviewBlockKey(key)) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    const rt = obj.__resolveType;
    if (typeof rt !== "string") continue;
    if (PAGE_BLOCK_RESOLVE_TYPES.has(rt)) continue;
    if (typeof obj.path === "string") continue;
    if (shouldSkipSectionResolveType(rt)) continue;
    if (!isManifestSectionResolveType(meta, rt)) continue;

    entries.push({
      resolveType: key,
      title: key,
      description: typeof obj.name === "string" ? obj.name : undefined,
      previewBlock: key,
      isSavedBlock: true,
    });
  }

  return entries;
}

function catalogEntryFromSchemaRef(
  meta: LiveMeta,
  ref: { resolveType: string; title: string; description?: string },
): SectionCatalogEntry {
  const isSaved = isSavedBlockResolveType(ref.resolveType);
  const metadata = isSaved
    ? {}
    : resolveBlockSchemaMetadata(ref.resolveType, meta);

  return {
    resolveType: ref.resolveType,
    title: ref.title || metadata.title || labelFromResolveType(ref.resolveType),
    description: ref.description ?? metadata.description,
    // Saved blocks preview by block id so the runtime resolver loads `.deco/blocks/{id}.json`.
    previewBlock: ref.resolveType,
    isSavedBlock: isSaved,
  };
}

/**
 * Lists sections that can be inserted into a page.
 * Merges manifest sections, page schema anyOf refs, and saved global blocks.
 */
export function extractSectionCatalog(
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): SectionCatalogEntry[] {
  const livePageRt = findLivePageResolveType(meta);
  const pageSchema = resolveSchema(livePageRt, meta);
  const refs = collectAnyOfRefsFromSchema(pageSchema?.properties?.sections);

  const byResolveType = new Map<string, SectionCatalogEntry>();

  const addEntry = (entry: SectionCatalogEntry) => {
    if (shouldSkipSectionResolveType(entry.resolveType)) return;
    if (isSavedBlockResolveType(entry.resolveType)) {
      if (!isAutoPreviewBlockKey(entry.resolveType)) {
        byResolveType.set(entry.resolveType, entry);
      }
      return;
    }
    if (!isManifestSectionResolveType(meta, entry.resolveType)) return;
    if (!byResolveType.has(entry.resolveType)) {
      byResolveType.set(entry.resolveType, entry);
    }
  };

  for (const entry of listManifestSections(meta)) {
    addEntry(entry);
  }

  for (const ref of refs) {
    addEntry(catalogEntryFromSchemaRef(meta, ref));
  }

  for (const entry of listSavedSectionBlocks(meta, decofile)) {
    addEntry(entry);
  }

  return [...byResolveType.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

/** Site theme block from decofile — included in section previews like admin. */
export function findSiteThemeBlock(
  decofile: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const site = decofile.site;
  if (!site || typeof site !== "object" || Array.isArray(site))
    return undefined;
  const theme = (site as Record<string, unknown>).theme;
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
    return undefined;
  }
  return theme as Record<string, unknown>;
}
