import { isManifestAppResolveType } from "./block-type-utils";
import {
  isResolvableManifestApp,
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "./resolve-schema";
import { listSavedSectionBlocks } from "./section-catalog";

export interface PageEntry {
  key: string;
  name: string;
  path: string;
}

export interface GlobalSectionEntry {
  key: string;
  name: string;
  resolveType: string;
}

export interface AppEntry {
  key: string;
  name: string;
  resolveType: string;
}

function parsePageName(key: string): string {
  // "pages-home-c4bcbfb771e9" -> "home"
  // "pages-Category%20Page-69217" -> "Category Page"
  let name = key;
  if (name.startsWith("pages-")) name = name.slice(6);
  // Remove trailing hash suffix (last segment after last -)
  const lastDash = name.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = name.slice(lastDash + 1);
    // Only strip if suffix looks like a hash (hex or short number)
    if (/^[a-f0-9]+$/i.test(suffix) && suffix.length >= 8) {
      name = name.slice(0, lastDash);
    }
  }
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

/** Canonical decofile block id for the site app (matches admin `SITE_APP_ID`). */
export const SITE_APP_BLOCK_KEY = "site";

/** Well-known resolve type for the site app block. */
export const SITE_APP_RESOLVE_TYPE = "site/apps/site.ts";

export function isSiteAppBlock(
  blockKey: string,
  block: Record<string, unknown>,
): boolean {
  if (blockKey === SITE_APP_BLOCK_KEY) return true;
  return block.__resolveType === SITE_APP_RESOLVE_TYPE;
}

/**
 * Same gate as Preview's "Sections editor" mode and the Content tab:
 * pages, global sections, site app, or installed deco apps.
 */
export function hasEditableDecoContent(
  decofile: Record<string, unknown> | undefined | null,
  meta: LiveMeta | undefined | null,
): boolean {
  if (!decofile) return false;
  if (extractPages(decofile).length > 0) return true;
  if (!meta) return false;
  if (extractGlobalSections(decofile, meta).length > 0) return true;
  if (findSiteAppEntry(decofile, meta)) return true;
  return extractApps(decofile, meta).length > 0;
}

export function extractPages(decofile: Record<string, unknown>): PageEntry[] {
  const pages: PageEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (
        typeof obj.__resolveType === "string" &&
        PAGE_RESOLVE_TYPES.has(obj.__resolveType) &&
        typeof obj.path === "string"
      ) {
        pages.push({
          key,
          name: typeof obj.name === "string" ? obj.name : parsePageName(key),
          path: obj.path,
        });
      }
    }
  }
  return pages;
}

export function globalSectionLabel(
  blockId: string,
  block: Record<string, unknown>,
): string {
  if (typeof block.name === "string") {
    const trimmed = block.name.trim();
    if (trimmed) return trimmed;
  }
  return blockId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function appLabel(
  blockKey: string,
  block: Record<string, unknown>,
  meta: LiveMeta,
): string {
  const resolveType =
    typeof block.__resolveType === "string" ? block.__resolveType : "";
  const metadata = resolveType
    ? resolveBlockSchemaMetadata(resolveType, meta)
    : {};
  if (metadata.title) return metadata.title;
  if (typeof block.name === "string") {
    const trimmed = block.name.trim();
    if (trimmed) return trimmed;
  }
  return blockKey
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function findSiteAppEntry(
  decofile: Record<string, unknown>,
  meta: LiveMeta,
): AppEntry | null {
  const direct = decofile[SITE_APP_BLOCK_KEY];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const obj = direct as Record<string, unknown>;
    const resolveType = obj.__resolveType;
    if (
      typeof resolveType === "string" &&
      isManifestAppResolveType(meta, resolveType)
    ) {
      return {
        key: SITE_APP_BLOCK_KEY,
        name: appLabel(SITE_APP_BLOCK_KEY, obj, meta),
        resolveType,
      };
    }
  }

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    if (obj.__resolveType !== SITE_APP_RESOLVE_TYPE) continue;
    if (!isManifestAppResolveType(meta, SITE_APP_RESOLVE_TYPE)) continue;

    return {
      key,
      name: appLabel(key, obj, meta),
      resolveType: SITE_APP_RESOLVE_TYPE,
    };
  }

  return null;
}

/** Installed app blocks from the decofile (manifest `apps` block type). */
export function extractApps(
  decofile: Record<string, unknown>,
  meta: LiveMeta,
): AppEntry[] {
  const apps: AppEntry[] = [];

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    const resolveType = obj.__resolveType;
    if (typeof resolveType !== "string") continue;
    if (PAGE_RESOLVE_TYPES.has(resolveType)) continue;
    if (typeof obj.path === "string") continue;
    if (isSiteAppBlock(key, obj)) continue;
    if (!isResolvableManifestApp(meta, resolveType)) continue;

    apps.push({
      key,
      name: appLabel(key, obj, meta),
      resolveType,
    });
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** Saved section blocks from the decofile (same filters as the section catalog). */
export function extractGlobalSections(
  decofile: Record<string, unknown>,
  meta: LiveMeta,
): GlobalSectionEntry[] {
  return listSavedSectionBlocks(meta, decofile)
    .map((entry) => {
      const block = decofile[entry.resolveType] as Record<string, unknown>;
      const resolveType =
        typeof block.__resolveType === "string" ? block.__resolveType : "";
      return {
        key: entry.resolveType,
        name: entry.description ?? globalSectionLabel(entry.resolveType, block),
        resolveType,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
