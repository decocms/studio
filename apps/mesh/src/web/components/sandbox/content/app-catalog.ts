import {
  isSiteAppBlock,
  SITE_APP_RESOLVE_TYPE,
  type AppEntry,
} from "@/web/components/sections-editor/page-list";
import {
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "@/web/components/sections-editor/resolve-schema";

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
  const match = resolveType.match(/^([^/]+)\/apps\/([^/.]+)\.tsx?$/);
  if (!match) return null;
  return { vendor: match[1]!, app: match[2]! };
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

  // Installed apps missing from store/schema (legacy block ids, local apps).
  for (const installed of listInstalledAppEntries(decofile, meta)) {
    const parsed = parseAppResolveType(installed.resolveType);
    if (!parsed) continue;
    const id = appBlockId(parsed.vendor, parsed.app);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      app: parsed.app,
      vendor: parsed.vendor,
      title: installed.name,
      description: "",
      category: "Installed",
      resolveType: installed.resolveType,
      blockKey: installed.key,
      installed: true,
    });
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

function manifestHasApp(meta: LiveMeta, vendor: string, app: string): boolean {
  const apps = meta.manifest?.blocks?.apps ?? {};
  for (const alias of [
    appResolveType(vendor, app),
    `${vendor}/apps/${app}.ts`,
    `${vendor}/apps/${app}.tsx`,
  ]) {
    if (alias in apps) return true;
  }
  return false;
}

function listInstalledAppEntries(
  decofile: Record<string, unknown>,
  meta: LiveMeta,
): AppEntry[] {
  const entries: AppEntry[] = [];

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    const resolveType = obj.__resolveType;
    if (typeof resolveType !== "string") continue;
    if (isSiteAppBlock(key, obj)) continue;

    const parsed =
      parseAppResolveType(resolveType) ??
      (() => {
        const blockIdMatch = key.match(/^([^-]+)-(.+)$/);
        return blockIdMatch
          ? { vendor: blockIdMatch[1]!, app: blockIdMatch[2]! }
          : null;
      })();

    if (!parsed || !manifestHasApp(meta, parsed.vendor, parsed.app)) continue;

    entries.push({
      key,
      name: key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      resolveType,
    });
  }

  return entries;
}

export function installedAppCount(catalog: AppCatalogEntry[]): number {
  return catalog.filter((entry) => entry.installed).length;
}
