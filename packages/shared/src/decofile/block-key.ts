/**
 * Decofile block ids are object keys (may include spaces, % encoding).
 * A block key maps to the on-disk file `.deco/blocks/<encodeURIComponent(key)>.json`.
 *
 * Isomorphic: consumed by the web CMS editors and by the server-side decofile
 * API, which must agree byte-for-byte on the key <-> filename mapping.
 */

/** Reject anything that could escape `.deco/blocks/<key>.json` via path segments. */
function containsPathTraversal(segment: string): boolean {
  if (
    !segment ||
    segment.includes("\\") ||
    segment.includes("..") ||
    segment.includes("\0")
  ) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(segment);
    if (
      decoded.includes("\\") ||
      decoded.includes("..") ||
      decoded.includes("\0")
    ) {
      return true;
    }
    // `%2F` is a legit deco key (slash-named page, like `%20` for a space); the whole key is re-encoded by blockKeyToFileStem, so only the `..`/`\`/NUL above can traverse.
    return false;
  } catch {
    return true;
  }
}

export function assertSafeDecoBlockKey(blockKey: string): void {
  if (containsPathTraversal(blockKey)) {
    throw new Error(`Invalid block key: ${blockKey || "(empty)"}`);
  }
}

/**
 * A block key that collides with a framework resolver module — e.g.
 * `website/flags/multivariate/section.ts`, `site/sections/Foo.tsx`,
 * `apps/deco/mod.ts`. Real decofile block ids are names/ids and never carry a
 * source-file extension, so a `set` under such a key writes a
 * `.deco/blocks/<encoded>.json` that shadows the native resolver for the whole
 * site. Writes (create/update) must reject these; deletes must NOT — an
 * already-shadowed resolver has to be removable to repair the site.
 */
export function isReservedResolverBlockKey(blockKey: string): boolean {
  return /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/.test(blockKey);
}

/** Block key from an on-disk `.deco/blocks/<stem>.json` filename stem. */
export function decoBlockKeyFromFileStem(stem: string): string {
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/**
 * Filename stem for `.deco/blocks/<stem>.json`.
 * Deco encodes the block id as-is (`encodeURIComponent`), so a key like
 * `pages-Home%20Page-<uuid>` maps to `pages-Home%2520Page-<uuid>.json`.
 */
export function blockKeyToFileStem(blockKey: string): string {
  assertSafeDecoBlockKey(blockKey);
  return encodeURIComponent(blockKey);
}

export function decoBlockFilePath(blockKey: string): string {
  return `.deco/blocks/${blockKeyToFileStem(blockKey)}.json`;
}
