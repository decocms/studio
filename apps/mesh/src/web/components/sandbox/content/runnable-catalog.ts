import { isAutoPreviewBlockKey } from "@/web/components/sections-editor/block-type-utils";
import {
  resolveBlockSchemaMetadata,
  type LiveMeta,
} from "@/web/components/sections-editor/resolve-schema";
import { labelFromResolveType } from "@/web/components/sections-editor/section-types";

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
  const seen = new Set<string>();

  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes(kind)) continue;
    for (const resolveType of Object.keys(blockMap)) {
      if (resolveType.toLowerCase().includes("preview")) continue;
      if (seen.has(resolveType)) continue;
      seen.add(resolveType);
      const metadata = resolveBlockSchemaMetadata(resolveType, meta);
      if (metadata.hidden) continue;
      entries.push({
        resolveType,
        title: metadata.title ?? labelFromResolveType(resolveType),
      });
    }
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

function runnableGroupTitle(key: string): string {
  return GROUP_TITLES[key] ?? key;
}

export interface RunnableGroup {
  key: string;
  title: string;
  entries: RunnableEntry[];
}

/** Group runnables by app/vendor namespace, sorted by group then title. */
export function groupRunnables(entries: RunnableEntry[]): RunnableGroup[] {
  const byKey = new Map<string, RunnableEntry[]>();
  for (const entry of entries) {
    const key = runnableGroupKey(entry.resolveType);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }
  return [...byKey.entries()]
    .map(([key, groupEntries]) => ({
      key,
      title: runnableGroupTitle(key),
      entries: groupEntries.sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
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
    if (!isManifestRunnableResolveType(meta, rt, kind)) continue;

    entries.push({
      key,
      resolveType: rt,
      title: typeof obj.name === "string" && obj.name ? obj.name : key,
    });
  }

  return entries.sort((a, b) => a.title.localeCompare(b.title));
}
