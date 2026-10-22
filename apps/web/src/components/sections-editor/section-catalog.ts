import { isV8Schema } from "@decocms/shared/blocks-major";
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
import {
  labelFromResolveType,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";
import { V8_MULTIVARIATE_RESOLVE_TYPE, variantValueOn } from "./variant-shape";

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

/** Page block of current deco runtimes — what {@link findLivePageResolveType} falls back to without a manifest. */
export const DEFAULT_LIVE_PAGE_RESOLVE_TYPE = LIVE_PAGE_RESOLVE_TYPES[0];

/** Theme sections belong in site settings, not the page section picker. */
const EXCLUDED_SECTION_RESOLVE_TYPES = new Set([
  "site/sections/Theme/Theme.tsx",
]);

/**
 * Next-major Blocks names block types with short keys (`theme`, `hero`), not
 * file paths, so the v7 path above never matches there: on a Blocks v8 site
 * (`v8`) a short key named `theme` (any case) is the site's theme too. On v7
 * such a key is a saved block like any other, as before.
 */
function isExcludedSectionResolveType(
  resolveType: string,
  v8: boolean,
): boolean {
  if (EXCLUDED_SECTION_RESOLVE_TYPES.has(resolveType)) return true;
  return (
    v8 && !resolveType.includes("/") && resolveType.toLowerCase() === "theme"
  );
}

function shouldSkipSectionResolveType(
  resolveType: string,
  meta: LiveMeta,
): boolean {
  if (isExcludedSectionResolveType(resolveType, isV8Schema(meta))) return true;
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
  // Next-major sites: the built-in `page` (or the site's override of it).
  if (Object.hasOwn(blocks.pages ?? {}, "page")) return "page";
  return DEFAULT_LIVE_PAGE_RESOLVE_TYPE;
}

/**
 * Whether the site declares the next-major built-in `page` (or its own
 * override of it). Its schema then also lists the v7 page names as aliases,
 * which {@link findLivePageResolveType} may pick, so callers that WRITE a page
 * type use {@link findNewPageResolveType} instead.
 */
export function declaresBuiltInPage(meta: LiveMeta | undefined): boolean {
  // Only a Blocks v8 site's schema (`isV8Schema`) declares it.
  if (!isV8Schema(meta)) return false;
  return Object.hasOwn(meta?.manifest?.blocks?.pages ?? {}, "page");
}

/** Whether a page type is one of the v7 (Fresh/Deno) page file names. */
export function isLegacyPageResolveType(resolveType: string): boolean {
  return PAGE_BLOCK_RESOLVE_TYPES.has(resolveType);
}

/**
 * The page type a NEW page is saved with: the one the site declares — `page`
 * on next-major sites, the v7 file name otherwise (and without a manifest).
 */
export function findNewPageResolveType(meta: LiveMeta | undefined): string {
  if (!meta) return DEFAULT_LIVE_PAGE_RESOLVE_TYPE;
  if (declaresBuiltInPage(meta)) return "page";
  return findLivePageResolveType(meta);
}

/** Collects block-ref variants from a resolved schema subtree (e.g. page `seo` or `sections`). */
export function collectAnyOfRefsFromSchema(
  schema: SchemaProperty | null | undefined,
): Array<{ resolveType: string; title: string; description?: string }> {
  if (!schema) return [];
  if (schema.anyOfRefs?.length) return schema.anyOfRefs;
  if (schema.items) return collectAnyOfRefsFromSchema(schema.items);
  if (schema.properties) {
    const refs: Array<{
      resolveType: string;
      title: string;
      description?: string;
    }> = [];
    for (const child of Object.values(schema.properties)) {
      refs.push(...collectAnyOfRefsFromSchema(child));
    }
    return refs;
  }
  return [];
}

function listManifestSections(meta: LiveMeta): SectionCatalogEntry[] {
  const blocks = meta.manifest?.blocks ?? {};
  const entries: SectionCatalogEntry[] = [];

  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("sections")) continue;

    for (const resolveType of Object.keys(blockMap)) {
      if (shouldSkipSectionResolveType(resolveType, meta)) continue;

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

/**
 * Cheap list of insertable manifest sections for the Content "Available
 * sections" list — labels come from the resolve type, NOT from resolving each
 * section's schema (that is O(sections) deep `$ref` walks and froze the tab on
 * sites with many sections). The full schema is resolved lazily, only when a
 * single section is opened for editing.
 */
export function listAvailableSections(
  meta: LiveMeta,
): Array<{ resolveType: string; title: string }> {
  const blocks = meta.manifest?.blocks ?? {};
  const byResolveType = new Map<
    string,
    { resolveType: string; title: string }
  >();

  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("sections")) continue;
    for (const resolveType of Object.keys(blockMap)) {
      if (shouldSkipSectionResolveType(resolveType, meta)) continue;
      if (byResolveType.has(resolveType)) continue;
      byResolveType.set(resolveType, {
        resolveType,
        title: labelFromResolveType(resolveType),
      });
    }
  }

  return [...byResolveType.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

/**
 * For a saved block wrapped in the multivariate section flag
 * (`website/flags/multivariate/section.ts`), the underlying component's
 * resolveType — read from the first variant that resolves to a manifest
 * section (with A/B variants + matcher rules). Mirrors how the runtime
 * resolves the block ref. Non-multivariate blocks (or a flag with no
 * resolvable variant) just return their own resolveType unchanged.
 */
export function underlyingSectionResolveType(
  meta: LiveMeta,
  block: Record<string, unknown>,
): string {
  const rt = block.__resolveType;
  if (typeof rt !== "string") return "";
  const v8 = isV8Schema(meta);
  if (!isSectionMultivariateBlockType(rt, v8)) return rt;

  const variants = block.variants;
  if (!Array.isArray(variants)) return rt;

  for (const variant of variants) {
    const value = variantValueOn(variant, v8) as
      | Record<string, unknown>
      | undefined;
    if (!value || typeof value !== "object") continue;

    // Lazy-wrapped section values nest the real section under `.section`.
    let variantRt = value.__resolveType;
    if (typeof variantRt === "string" && isLazyResolveType(variantRt)) {
      const inner = value.section as Record<string, unknown> | undefined;
      variantRt = inner?.__resolveType ?? variantRt;
    }
    if (
      typeof variantRt === "string" &&
      isManifestSectionResolveType(meta, variantRt)
    ) {
      return variantRt;
    }
  }

  return rt;
}

/**
 * The v7 section flag, or on a Blocks v8 site (`v8`) its `multivariate`
 * (which wraps any value). On v7 a short `multivariate` is a saved block.
 */
function isSectionMultivariateBlockType(rt: string, v8: boolean): boolean {
  return (
    rt === SECTION_MULTIVARIATE_RESOLVE_TYPE ||
    (v8 && rt === V8_MULTIVARIATE_RESOLVE_TYPE)
  );
}

/**
 * A saved block whose top-level resolveType is the multivariate section flag
 * is still an insertable section — confirm at least one variant resolves to a
 * manifest section so a dead flag isn't offered.
 */
function multivariateWrapsManifestSection(
  meta: LiveMeta,
  block: Record<string, unknown>,
): boolean {
  return underlyingSectionResolveType(meta, block) !== block.__resolveType;
}

export function listSavedSectionBlocks(
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
    if (shouldSkipSectionResolveType(rt, meta)) continue;

    const isSectionBlock =
      isManifestSectionResolveType(meta, rt) ||
      (isSectionMultivariateBlockType(rt, isV8Schema(meta)) &&
        multivariateWrapsManifestSection(meta, obj));
    if (!isSectionBlock) continue;

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
  const isSaved = isSavedBlockResolveType(ref.resolveType, meta);
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
    if (shouldSkipSectionResolveType(entry.resolveType, meta)) return;
    if (isSavedBlockResolveType(entry.resolveType, meta)) {
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
