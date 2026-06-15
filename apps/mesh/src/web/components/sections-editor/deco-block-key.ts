/**
 * Decofile block ids are object keys (may include spaces, % encoding).
 * Reject anything that could escape `.deco/blocks/<key>.json` via path segments.
 */
function containsPathTraversal(segment: string): boolean {
  if (
    !segment ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("..") ||
    segment.includes("\0")
  ) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("..") ||
      decoded.includes("\0")
    );
  } catch {
    return true;
  }
}

export function assertSafeDecoBlockKey(blockKey: string): void {
  if (containsPathTraversal(blockKey)) {
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
