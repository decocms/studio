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

export function decoBlockFilePath(blockKey: string): string {
  assertSafeDecoBlockKey(blockKey);
  return `.deco/blocks/${blockKey}.json`;
}
