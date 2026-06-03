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

function decodeDecoBlockKey(blockKey: string): string {
  try {
    return decodeURIComponent(blockKey);
  } catch {
    return blockKey;
  }
}

/** Filename stem for `.deco/blocks/<stem>.json` (decode then encode to avoid `%2520`). */
export function blockKeyToFileStem(blockKey: string): string {
  assertSafeDecoBlockKey(blockKey);
  return encodeURIComponent(decodeDecoBlockKey(blockKey));
}

export function decoBlockFilePath(blockKey: string): string {
  return `.deco/blocks/${blockKeyToFileStem(blockKey)}.json`;
}
