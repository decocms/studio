import type { LiveMeta } from "./resolve-schema";

/** Saved block union titles: `#site/sections/Foo.tsx@BlockId`. */
export function parseSavedBlockSchemaTitle(
  title: string,
): { blockId: string; moduleResolveType: string } | null {
  if (!title.startsWith("#") || !title.includes("@")) return null;
  const atIndex = title.indexOf("@");
  return {
    moduleResolveType: title.slice(1, atIndex),
    blockId: title.slice(atIndex + 1),
  };
}

/**
 * Inline union variants in the same TS module (e.g. `ImageBanner | VideoBanner`
 * inside `Carousel.tsx`) use schema enum values like
 * `base64(fileUrl)@ImageBanner`. Those identifiers are for schema
 * discrimination only — persisting them as `__resolveType` in decofile data
 * makes deco treat the object as a loadable block and throws DanglingReference.
 */
export function isEmbeddedUnionResolveType(resolveType: string): boolean {
  return resolveType.includes("@");
}

/** Block name suffix from an embedded union resolve type (`…@ImageBanner`). */
export function embeddedUnionBlockId(resolveType: string): string | null {
  const at = resolveType.lastIndexOf("@");
  if (at < 0 || at === resolveType.length - 1) return null;
  return resolveType.slice(at + 1);
}

export function unionRefMatchesValue(
  refResolveType: string,
  valueResolveType: string,
): boolean {
  if (refResolveType === valueResolveType) return true;
  const refId = embeddedUnionBlockId(refResolveType);
  if (!refId) return false;
  return (
    valueResolveType === refId ||
    embeddedUnionBlockId(valueResolveType) === refId
  );
}

function getManifestBlockType(
  meta: LiveMeta,
  resolveType: string,
): string | null {
  const blocks = meta.manifest?.blocks ?? {};
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (resolveType in blockMap) return blockType;
  }
  return null;
}

export function isManifestSectionResolveType(
  meta: LiveMeta,
  resolveType: string,
): boolean {
  const blockType = getManifestBlockType(meta, resolveType);
  return blockType !== null && blockType.includes("sections");
}

export function isManifestMatcherResolveType(
  meta: LiveMeta,
  resolveType: string,
): boolean {
  const blockType = getManifestBlockType(meta, resolveType);
  return blockType !== null && blockType.includes("matchers");
}

/** Block id reference (no module path) — e.g. `Header`, not `site/sections/Header.tsx`. */
export function isSavedBlockResolveType(resolveType: string): boolean {
  return !resolveType.includes("/");
}

/** Auto-generated preview stubs under `.deco/blocks/Preview …`. */
export function isAutoPreviewBlockKey(blockKey: string): boolean {
  try {
    return decodeURIComponent(blockKey).startsWith("Preview ");
  } catch {
    return blockKey.startsWith("Preview ");
  }
}
