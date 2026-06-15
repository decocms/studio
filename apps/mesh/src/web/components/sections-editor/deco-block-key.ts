/**
 * Decofile block ids are object keys (may include spaces, % encoding).
 * Reject anything that could escape `.deco/blocks/<key>.json` via path segments.
 */
export function assertSafeDecoBlockKey(blockKey: string): void {
  if (
    !blockKey ||
    blockKey.includes("/") ||
    blockKey.includes("\\") ||
    blockKey.includes("..")
  ) {
    throw new Error(`Invalid block key: ${blockKey || "(empty)"}`);
  }
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

/** Path shape used by the sandbox file explorer deep-link (`openPath`). */
export function decoBlockFileViewPath(blockKey: string): string {
  return `/${decoBlockFilePath(blockKey)}`;
}
