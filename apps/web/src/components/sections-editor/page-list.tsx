import {
  isDecoAppResolveType,
  isResolvableManifestApp,
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "./resolve-schema";
import { normalizePagePath } from "./page-path-utils";
import { listSavedSectionBlocks } from "./section-catalog";
import { extractRedirects } from "@/components/sandbox/content/redirect-data";

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

/** Display name for a page block key, when its content isn't available. */
export function parsePageName(key: string): string {
  // "pages-home-c4bcbfb771e9" -> "home"
  // "pages-Category%20Page-69217" -> "Category Page"
  let name = key;
  if (name.startsWith("pages-")) name = name.slice(6);
  // Remove trailing uuid suffix (dashed uuid or legacy hex blob).
  name = name.replace(
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "",
  );
  name = name.replace(/-[0-9a-f]{8,}$/i, "");
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The storefront "." deep-link: a CMS page id and the URL the user was on. */
export interface PageDeepLink {
  pageId?: string;
  path?: string;
  pathTemplate?: string;
}

/**
 * Resolve the storefront deep-link to a decofile page. The storefront sends a
 * CMS `pageId`, the concrete `path` the user was on, and that route's
 * `pathTemplate`. Page blocks are keyed `pages-<name>-<id>` and their `path`
 * field stores the *template* (e.g. `/produto/*`), so we try, in order: the
 * page id (exact key, then `-<id>` suffix), the template, then the concrete
 * path (for static pages where the two coincide). Returns null if nothing fits.
 */
export function resolveDeepLinkPage(
  pages: PageEntry[],
  link: PageDeepLink,
): PageEntry | null {
  const { pageId, path, pathTemplate } = link;

  if (pageId) {
    const exact = pages.find((p) => p.key === pageId);
    if (exact) return exact;
    const suffixed = pages.find((p) => p.key.endsWith(`-${pageId}`));
    if (suffixed) return suffixed;
  }

  if (pathTemplate) {
    const byTemplate = findPageForPath(pages, pathTemplate);
    if (byTemplate) return byTemplate;
  }

  if (path) {
    const byPath = findPageForPath(pages, path);
    if (byPath) return byPath;
  }

  return null;
}

/** Pick the page block for a path; honors an explicit key when paths collide. */
export function findPageForPath(
  pages: PageEntry[],
  path: string,
  preferredKey?: string | null,
): PageEntry | null {
  const norm = normalizePagePath;

  if (preferredKey) {
    const preferred = pages.find((p) => p.key === preferredKey);
    if (preferred) return preferred;
  }

  const matches = pages.filter((p) => norm(p.path) === norm(path));
  if (matches.length === 0) return null;

  if (matches.length === 1) return matches[0] ?? null;
  return [...matches].sort((a, b) => a.key.localeCompare(b.key))[0] ?? null;
}

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

/** Canonical decofile block id for the site app (matches admin `SITE_APP_ID`). */
const SITE_APP_BLOCK_KEY = "site";

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
  if (extractRedirects(decofile).length > 0) return true;
  if (!meta) return false;
  if (extractGlobalSections(decofile, meta).length > 0) return true;
  if (findSiteAppEntry(decofile, meta)) return true;
  return extractApps(decofile, meta).length > 0;
}

/** Classify one decofile entry as a page; null for any other block shape. */
export function pageEntryFromBlock(
  key: string,
  val: unknown,
): PageEntry | null {
  if (!val || typeof val !== "object" || Array.isArray(val)) return null;
  const obj = val as Record<string, unknown>;
  if (
    typeof obj.__resolveType !== "string" ||
    !PAGE_RESOLVE_TYPES.has(obj.__resolveType) ||
    typeof obj.path !== "string"
  ) {
    return null;
  }
  return {
    key,
    name: typeof obj.name === "string" ? obj.name : parsePageName(key),
    path: obj.path,
  };
}

export function extractPages(decofile: Record<string, unknown>): PageEntry[] {
  const pages: PageEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    const page = pageEntryFromBlock(key, val);
    if (page) pages.push(page);
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
      (isSiteAppBlock(SITE_APP_BLOCK_KEY, obj) ||
        isResolvableManifestApp(meta, resolveType))
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
    if (!isSiteAppBlock(key, obj)) continue;

    const resolveType =
      typeof obj.__resolveType === "string"
        ? obj.__resolveType
        : SITE_APP_RESOLVE_TYPE;

    return {
      key,
      name: appLabel(key, obj, meta),
      resolveType,
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
    if (
      !isResolvableManifestApp(meta, resolveType) &&
      !isDecoAppResolveType(resolveType)
    ) {
      continue;
    }

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
