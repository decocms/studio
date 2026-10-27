import {
  isDecoAppResolveType,
  isResolvableManifestApp,
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "./resolve-schema";
import { isPageResolveType } from "./page-types";
import { normalizePagePath } from "./page-path-utils";
import {
  listSavedSectionBlocks,
  underlyingSectionResolveType,
} from "./section-catalog";
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
  // A numeric id ("Search Page-514254"); a short number (a year) is kept.
  name = name.replace(/-\d{5,}$/, "");
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
 * page id (exact key, then `-<id>` suffix), a page whose path is exactly the
 * one the user was on (a static page serves its own path ahead of any
 * template), then the template. A storefront that doesn't know its page sends
 * the catch-all `/*` as the template; checking the path first keeps "." on the
 * home page from opening the Not Found page. Returns null if nothing fits.
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

  if (path) {
    const byPath = findPageForPath(pages, path);
    if (byPath) return byPath;
  }

  if (pathTemplate) {
    const byTemplate = findPageForPath(pages, pathTemplate);
    if (byTemplate) return byTemplate;
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
  if (extractPages(decofile, meta).length > 0) return true;
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
  meta?: LiveMeta | null,
): PageEntry | null {
  if (!val || typeof val !== "object" || Array.isArray(val)) return null;
  const obj = val as Record<string, unknown>;
  if (
    typeof obj.__resolveType !== "string" ||
    !isPageResolveType(obj.__resolveType, meta) ||
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

export function extractPages(
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): PageEntry[] {
  const pages: PageEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    const page = pageEntryFromBlock(key, val, meta);
    if (page) pages.push(page);
  }
  return pages;
}

/** Whether `value` holds `{ "__resolveType": <one of keys> }` at any depth. */
function referencesAny(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 64 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => referencesAny(item, keys, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.__resolveType === "string" && keys.has(obj.__resolveType)) {
    return true;
  }
  return Object.values(obj).some((item) =>
    referencesAny(item, keys, depth + 1),
  );
}

/**
 * The pages whose content shows the saved block `blockKey`: those that
 * reference it (`{ "__resolveType": blockKey }` at any depth, inside a lazy
 * wrapper too) or reference another saved block that does. In decofile order.
 * Reads only the content already in hand: no request, no site code.
 */
export function pagesShowingBlock(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): PageEntry[] {
  const pages = extractPages(decofile, meta);
  const pageKeys = new Set(pages.map((page) => page.key));
  const shown = new Set([blockKey]);
  // Saved blocks that show it, through any chain of references.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [key, value] of Object.entries(decofile)) {
      if (shown.has(key) || pageKeys.has(key)) continue;
      if (referencesAny(value, shown)) {
        shown.add(key);
        grew = true;
      }
    }
  }
  return pages.filter(
    (page) => page.key !== blockKey && referencesAny(decofile[page.key], shown),
  );
}

/**
 * The page to preview a saved block on (a Blocks v8 site has no
 * isolated-section route): of the pages that show it
 * ({@link pagesShowingBlock}), the home page first, then static pages by
 * path, then dynamic ones by path. `null` when no page shows it.
 */
export function previewPageForBlock(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): PageEntry | null {
  const rank = (page: PageEntry) =>
    normalizePagePath(page.path) === "/"
      ? 0
      : /:[A-Za-z0-9_-]|\*/.test(page.path)
        ? 2
        : 1;
  const [first] = pagesShowingBlock(decofile, blockKey, meta).sort(
    (a, b) =>
      rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return first ?? null;
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
    if (isPageResolveType(resolveType, meta)) continue;
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
      const resolveType = underlyingSectionResolveType(meta, block);
      return {
        key: entry.resolveType,
        name: entry.description ?? globalSectionLabel(entry.resolveType, block),
        resolveType,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
