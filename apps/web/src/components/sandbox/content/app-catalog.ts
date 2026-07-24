import {
  isSiteAppBlock,
  SITE_APP_RESOLVE_TYPE,
  appLabel,
} from "@/components/sections-editor/page-list";
import {
  isDecoAppResolveType,
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";

/** Row from GET /api/deco-apps (deco.cx app store). */
export interface DecoStoreApp {
  name: string;
  title: string;
  description: string;
  logo: string;
  category: string | null;
  vendor: { alias: string; url: string };
}

export interface AppCatalogEntry {
  /** Stable list id — `${vendor}-${app}`. */
  id: string;
  app: string;
  vendor: string;
  title: string;
  description: string;
  category: string;
  logo?: string;
  resolveType: string;
  /** Decofile block key when installed; null otherwise. */
  blockKey: string | null;
  installed: boolean;
}

export function appBlockId(vendor: string, app: string): string {
  return `${vendor}-${app}`;
}

export function appResolveType(vendor: string, app: string): string {
  return `site/apps/${vendor}/${app}.ts`;
}

export function parseAppResolveType(
  resolveType: string,
): { vendor: string; app: string } | null {
  const siteMatch = resolveType.match(/^site\/apps\/([^/]+)\/([^/.]+)\.tsx?$/);
  if (siteMatch) {
    return { vendor: siteMatch[1]!, app: siteMatch[2]! };
  }
  const legacyMatch = resolveType.match(/^([^/]+)\/apps\/([^/.]+)\.tsx?$/);
  if (legacyMatch) {
    return { vendor: legacyMatch[1]!, app: legacyMatch[2]! };
  }
  return null;
}

function parseAppIdentityFromBlockKey(
  blockKey: string,
): { vendor: string; app: string } | null {
  const blockIdMatch = blockKey.match(/^([^-]+)-(.+)$/);
  if (!blockIdMatch) return null;
  return { vendor: blockIdMatch[1]!, app: blockIdMatch[2]! };
}

function installedAppCategory(vendor: string): string {
  return vendor === "local" ? "Custom" : "Installed";
}

function findInstalledBlockKey(
  vendor: string,
  app: string,
  decofile: Record<string, unknown>,
): string | null {
  const candidates = new Set(
    [appBlockId(vendor, app), app].map((value) => value.toLowerCase()),
  );
  const expectedResolveType = appResolveType(vendor, app);

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (candidates.has(key.toLowerCase())) return key;
    if (obj.__resolveType === expectedResolveType) return key;
  }

  return null;
}

function catalogEntryFromStoreApp(
  storeApp: DecoStoreApp,
  decofile: Record<string, unknown>,
): AppCatalogEntry {
  const vendor = storeApp.vendor.alias;
  const app = storeApp.name;
  const blockKey = findInstalledBlockKey(vendor, app, decofile);

  return {
    id: appBlockId(vendor, app),
    app,
    vendor,
    title: storeApp.title || storeApp.name,
    description: storeApp.description,
    category: storeApp.category ?? "Other",
    logo: storeApp.logo || undefined,
    resolveType: appResolveType(vendor, app),
    blockKey,
    installed: blockKey !== null,
  };
}

function catalogEntryFromManifestApp(
  resolveType: string,
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): AppCatalogEntry | null {
  if (resolveType === SITE_APP_RESOLVE_TYPE) return null;

  const parsed = parseAppResolveType(resolveType);
  if (!parsed) return null;

  const { vendor, app } = parsed;
  const blockKey = findInstalledBlockKey(vendor, app, decofile);
  const metadata = resolveBlockSchemaMetadata(resolveType, meta);

  return {
    id: appBlockId(vendor, app),
    app,
    vendor,
    title: metadata.title ?? app,
    description: metadata.description ?? "",
    category: "Others",
    logo: metadata.logo ?? metadata.icon,
    resolveType,
    blockKey,
    installed: blockKey !== null,
  };
}

function catalogEntryFromInstalledBlock(
  blockKey: string,
  block: Record<string, unknown>,
  meta: LiveMeta,
): AppCatalogEntry | null {
  const resolveType = block.__resolveType;
  if (typeof resolveType !== "string") return null;
  if (isSiteAppBlock(blockKey, block)) return null;
  if (!isDecoAppResolveType(resolveType)) return null;

  const parsed =
    parseAppResolveType(resolveType) ?? parseAppIdentityFromBlockKey(blockKey);
  if (!parsed) return null;

  const metadata = resolveBlockSchemaMetadata(resolveType, meta);
  const { vendor, app } = parsed;

  return {
    id: appBlockId(vendor, app),
    app,
    vendor,
    title: metadata.title ?? appLabel(blockKey, block, meta),
    description: metadata.description ?? "",
    category: installedAppCategory(vendor),
    logo: metadata.logo ?? metadata.icon,
    resolveType,
    blockKey,
    installed: true,
  };
}

/**
 * Merges the deco app store, manifest schema apps, and installed decofile
 * blocks — mirrors admin's Apps view data sources.
 */
export function buildAppCatalog(
  storeApps: DecoStoreApp[],
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): AppCatalogEntry[] {
  const byId = new Map<string, AppCatalogEntry>();

  for (const storeApp of storeApps) {
    const entry = catalogEntryFromStoreApp(storeApp, decofile);
    byId.set(entry.id, entry);
  }

  const manifestApps = meta.manifest?.blocks?.apps ?? {};
  for (const resolveType of Object.keys(manifestApps)) {
    const entry = catalogEntryFromManifestApp(resolveType, meta, decofile);
    if (!entry || byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }

  // Installed custom/local apps and legacy block ids missing from store + manifest.
  for (const [blockKey, val] of Object.entries(decofile)) {
    if (blockKey.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const entry = catalogEntryFromInstalledBlock(
      blockKey,
      val as Record<string, unknown>,
      meta,
    );
    if (!entry || byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }

  return [...byId.values()].sort(compareAppCatalogEntries);
}

function compareAppCatalogEntries(
  a: AppCatalogEntry,
  b: AppCatalogEntry,
): number {
  if (a.installed !== b.installed) {
    return a.installed ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}
