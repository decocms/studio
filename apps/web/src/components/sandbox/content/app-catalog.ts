import {
  findSiteAppAnyStack,
  siteAppBlockKey,
  siteAppResolveType,
  type SiteAppRegistryEntry,
} from "@decocms/shared/site-apps";
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
  /**
   * Whether this entry came from the registry, and so can be installed from
   * here. Manifest- and decofile-derived entries describe what the site
   * already has; there is no patch set for them.
   */
  installable: boolean;
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

/** `app-tags` -> `App Tags`, for an app no schema or registry names. */
function humanizeAppName(app: string): string {
  return app
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface AppDisplay {
  title: string;
  description: string;
  category: string;
  logo?: string;
}

/**
 * What to show for an app the registry for THIS stack does not carry.
 *
 * The schema is the first choice but rarely helps: the generator titles every
 * app block with its own module path and emits no description or icon, so a
 * title equal to the resolveType is an id and has to be read as absent.
 */
function appDisplay(
  resolveType: string,
  vendor: string,
  app: string,
  fallbackTitle: string,
  fallbackCategory: string,
  meta: LiveMeta,
): AppDisplay {
  const metadata = resolveBlockSchemaMetadata(resolveType, meta);
  const schemaTitle =
    metadata.title && metadata.title !== resolveType
      ? metadata.title
      : undefined;
  const known = findSiteAppAnyStack(siteAppBlockKey(vendor, app));

  return {
    title: schemaTitle ?? known?.title ?? fallbackTitle,
    description: metadata.description ?? known?.description ?? "",
    category: known?.category ?? fallbackCategory,
    logo: metadata.logo ?? metadata.icon ?? known?.logo,
  };
}

function findInstalledBlockKey(
  vendor: string,
  app: string,
  decofile: Record<string, unknown>,
): string | null {
  const candidates = new Set(
    [siteAppBlockKey(vendor, app), app].map((value) => value.toLowerCase()),
  );
  const expectedResolveType = siteAppResolveType(vendor, app);

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (candidates.has(key.toLowerCase())) return key;
    if (obj.__resolveType === expectedResolveType) return key;
  }

  return null;
}

function catalogEntryFromRegistry(
  registryEntry: SiteAppRegistryEntry,
  decofile: Record<string, unknown>,
): AppCatalogEntry {
  const { vendor, app } = registryEntry;
  const blockKey = findInstalledBlockKey(vendor, app, decofile);

  return {
    id: registryEntry.blockKey,
    app,
    vendor,
    title: registryEntry.title,
    description: registryEntry.description,
    category: registryEntry.category,
    logo: registryEntry.logo,
    resolveType: siteAppResolveType(vendor, app),
    blockKey,
    installed: blockKey !== null,
    installable: true,
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

  return {
    id: siteAppBlockKey(vendor, app),
    app,
    vendor,
    ...appDisplay(
      resolveType,
      vendor,
      app,
      humanizeAppName(app),
      vendor === "local" ? "Custom" : "Others",
      meta,
    ),
    resolveType,
    blockKey,
    installed: blockKey !== null,
    installable: false,
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

  const { vendor, app } = parsed;

  return {
    id: siteAppBlockKey(vendor, app),
    app,
    vendor,
    ...appDisplay(
      resolveType,
      vendor,
      app,
      appLabel(blockKey, block, meta),
      installedAppCategory(vendor),
      meta,
    ),
    resolveType,
    blockKey,
    installed: true,
    installable: false,
  };
}

/** The stack's installable registry, merged with what the site already has. */
export function buildAppCatalog(
  registry: readonly SiteAppRegistryEntry[],
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): AppCatalogEntry[] {
  const byId = new Map<string, AppCatalogEntry>();

  for (const registryEntry of registry) {
    const entry = catalogEntryFromRegistry(registryEntry, decofile);
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
