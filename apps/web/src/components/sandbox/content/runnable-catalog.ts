import { isAutoPreviewBlockKey } from "@/components/sections-editor/block-type-utils";
import {
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { labelFromResolveType } from "@/components/sections-editor/section-types";
import { REDIRECT_LOADER_RESOLVE_TYPES } from "./redirect-data";

/** The two block kinds surfaced by the Loaders / Actions content tabs. */
export type RunnableKind = "loaders" | "actions";

/** An available (manifest) loader/action that can be configured and invoked. */
interface RunnableEntry {
  /** Manifest module resolveType, e.g. `site/loaders/products.ts`. */
  resolveType: string;
  title: string;
}

/** A loader/action already saved as a global block in the decofile. */
interface SavedRunnableEntry {
  /** Decofile block key. */
  key: string;
  /** The module resolveType the block instantiates. */
  resolveType: string;
  title: string;
}

const KIND_SINGULAR: Record<RunnableKind, string> = {
  loaders: "loader",
  actions: "action",
};

/**
 * App/vendor groups whose blocks are internal plumbing, not site content —
 * hidden from the Loaders/Actions tabs entirely (e.g. the workflows app's
 * `workflows/loaders/events.ts` / `get.ts`).
 */
const HIDDEN_RUNNABLE_GROUPS = new Set(["workflows"]);

export function runnableSingular(kind: RunnableKind): string {
  return KIND_SINGULAR[kind];
}

/**
 * Whether a resolveType is a manifest block of the given runnable kind. Mirrors
 * `isManifestSectionResolveType`: block-type keys carry the kind in their name
 * (e.g. `loaders`, `vtex/loaders`).
 */
export function isManifestRunnableResolveType(
  meta: LiveMeta,
  resolveType: string,
  kind: RunnableKind,
): boolean {
  const blocks = meta.manifest?.blocks ?? {};
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes(kind)) continue;
    if (resolveType in blockMap) return true;
  }
  return false;
}

/**
 * All manifest resolveTypes of the given runnable kind (loaders/actions). Unlike
 * {@link listAvailableRunnables} this is the raw set — no hidden/preview
 * filtering — for callers that need to pattern-match against every registered
 * loader (e.g. discovering a store's product-search loader dynamically).
 */
export function manifestLoaderResolveTypes(
  meta: LiveMeta,
  kind: RunnableKind,
): Set<string> {
  const resolveTypes = new Set<string>();
  const blocks = meta.manifest?.blocks ?? {};
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes(kind)) continue;
    for (const resolveType of Object.keys(blockMap)) {
      resolveTypes.add(resolveType);
    }
  }
  return resolveTypes;
}

/**
 * Tanstack manifests register most modules twice: a bare invoke-by-key alias
 * (`site/loaders/CheckStock`) plus the real module path
 * (`site/loaders/CheckStock.ts`). Only the suffixed entry carries the
 * generated props schema — the bare alias resolves to a `__resolveType`-only
 * stub — so the catalog drops it when its suffixed twin exists. Deno/fresh
 * manifests only ever list suffixed keys, making this a no-op there.
 */
function hasSuffixedAlias(resolveType: string, allKeys: Set<string>): boolean {
  if (/\.tsx?$/.test(resolveType)) return false;
  return allKeys.has(`${resolveType}.ts`) || allKeys.has(`${resolveType}.tsx`);
}

/**
 * Available (manifest) loaders/actions for the given kind. Skips preview stubs
 * and blocks the site marks hidden (deco `@ignore` / `hide` — the same signal
 * the section catalog respects), mirroring how admin keeps internal blocks out
 * of its pickers. Titles come from the block schema when present, else from the
 * resolveType.
 */
export function listAvailableRunnables(
  meta: LiveMeta,
  kind: RunnableKind,
): RunnableEntry[] {
  const blocks = meta.manifest?.blocks ?? {};
  const entries: RunnableEntry[] = [];

  const allKeys = new Set<string>();
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes(kind)) continue;
    for (const resolveType of Object.keys(blockMap)) allKeys.add(resolveType);
  }

  for (const resolveType of allKeys) {
    if (resolveType.toLowerCase().includes("preview")) continue;
    if (REDIRECT_LOADER_RESOLVE_TYPES.has(resolveType)) continue;
    if (HIDDEN_RUNNABLE_GROUPS.has(runnableGroupKey(resolveType))) continue;
    if (hasSuffixedAlias(resolveType, allKeys)) continue;
    const metadata = resolveBlockSchemaMetadata(resolveType, meta);
    if (metadata.hidden) continue;
    // Tanstack block defs title themselves with their own key — treat that as
    // "no title" so the list shows `CheckStock`, not the full module path.
    const title =
      metadata.title && metadata.title !== resolveType
        ? metadata.title
        : labelFromResolveType(resolveType);
    entries.push({ resolveType, title });
  }

  return entries.sort((a, b) => a.title.localeCompare(b.title));
}

/** Number of available (manifest) runnables of a kind. */
export function countAvailableRunnables(
  meta: LiveMeta,
  kind: RunnableKind,
): number {
  return listAvailableRunnables(meta, kind).length;
}

/**
 * App/vendor namespace a runnable belongs to, mirroring admin's `appFilterKey`:
 * `deco-sites/<site>/…` → the site name, deco engine (`$live`/`deco/…`) → `deco`,
 * everything else → the first path segment (the app/vendor, e.g. `vtex`).
 */
export function runnableGroupKey(resolveType: string): string {
  if (resolveType.startsWith("deco-sites/")) {
    return resolveType.split("/")[1] || "site";
  }
  if (resolveType.startsWith("$live") || resolveType.startsWith("deco/")) {
    return "deco";
  }
  return resolveType.split("/")[0] || "other";
}

/** Pretty label for a group key (mirrors admin's `mapTitleByKey`). */
const GROUP_TITLES: Record<string, string> = {
  deco: "Deco",
  std: "Deco Standard",
  website: "Website",
};

export function runnableGroupTitle(key: string): string {
  return GROUP_TITLES[key] ?? key;
}

/**
 * Folder path a runnable lives under, derived from its resolveType — the
 * grouping the folder-navigable UI walks. The first segment is the app/vendor
 * group ({@link runnableGroupKey}); the block-kind segment (`loaders`/`actions`,
 * constant within a tab) and the leaf filename are dropped.
 *
 * `vtex/loaders/intelligentSearch/productList.ts` → `["vtex", "intelligentSearch"]`
 * `site/loaders/products.ts`                      → `["site"]`
 * `$live/loaders/state.ts`                        → `["deco"]`
 * `deco-sites/mysite/loaders/product/detail.ts`   → `["mysite", "product"]`
 */
export function runnableFolderPath(resolveType: string): string[] {
  const root = runnableGroupKey(resolveType);
  const segments = resolveType.split("/").filter(Boolean);
  let rest = segments.slice(resolveType.startsWith("deco-sites/") ? 2 : 1);
  if (rest[0] === "loaders" || rest[0] === "actions") {
    rest = rest.slice(1);
  }
  // The last segment is the block file itself, not a folder.
  return [root, ...rest.slice(0, -1)];
}

/** Loaders/actions already saved as global blocks in the decofile. */
export function listSavedRunnables(
  meta: LiveMeta,
  decofile: Record<string, unknown>,
  kind: RunnableKind,
): SavedRunnableEntry[] {
  const entries: SavedRunnableEntry[] = [];

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (isAutoPreviewBlockKey(key)) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    const rt = obj.__resolveType;
    if (typeof rt !== "string") continue;
    if (REDIRECT_LOADER_RESOLVE_TYPES.has(rt)) continue;
    if (HIDDEN_RUNNABLE_GROUPS.has(runnableGroupKey(rt))) continue;
    if (!isManifestRunnableResolveType(meta, rt, kind)) continue;

    entries.push({
      key,
      resolveType: rt,
      title: typeof obj.name === "string" && obj.name ? obj.name : key,
    });
  }

  return entries.sort((a, b) => a.title.localeCompare(b.title));
}
