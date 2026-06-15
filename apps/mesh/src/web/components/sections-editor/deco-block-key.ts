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

/** Fully decode percent-encoding so `%2520` and `%20` keys collapse to the same id. */
export function normalizeDecoBlockKey(blockKey: string): string {
  let current = blockKey;
  for (let i = 0; i < 10; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

/** Filename stem for `.deco/blocks/<stem>.json` (normalize then encode once). */
export function blockKeyToFileStem(blockKey: string): string {
  assertSafeDecoBlockKey(blockKey);
  return encodeURIComponent(normalizeDecoBlockKey(blockKey));
}

export function decoBlockFilePath(blockKey: string): string {
  return `.deco/blocks/${blockKeyToFileStem(blockKey)}.json`;
}

/** All filename stems that may exist on disk for the same logical block id. */
export function alternateDecoBlockFileStems(blockKey: string): string[] {
  const normalized = normalizeDecoBlockKey(blockKey);
  const canonical = blockKeyToFileStem(blockKey);
  const stems = new Set<string>();

  const addStem = (value: string) => {
    try {
      assertSafeDecoBlockKey(value);
    } catch {
      return;
    }
    stems.add(value);
    stems.add(encodeURIComponent(value));
    try {
      stems.add(encodeURIComponent(decodeURIComponent(value)));
    } catch {
      // ignore invalid escape sequences
    }
  };

  addStem(normalized);
  if (blockKey !== normalized) addStem(blockKey);

  // Legacy admin writes: encodeURIComponent(canonicalStem) → `%2520` for spaces.
  stems.add(encodeURIComponent(canonical));

  return [...stems];
}

/**
 * Older writers stored blocks under alternate encodings (`%2520`, raw key stem, …).
 * Returns every on-disk path that is not the canonical path for `blockKey`.
 */
export function legacyDecoBlockFilePaths(blockKey: string): string[] {
  const canonicalStem = blockKeyToFileStem(blockKey);
  return alternateDecoBlockFileStems(blockKey)
    .filter((stem) => stem !== canonicalStem)
    .map((stem) => `.deco/blocks/${stem}.json`);
}

/** Path shape used by the sandbox file explorer deep-link (`openPath`). */
export function decoBlockFileViewPath(blockKey: string): string {
  return `/${decoBlockFilePath(blockKey)}`;
}

/** Collapse legacy `%2520` / `%20` aliases to one canonical decofile entry per block. */
export function normalizeDecofileKeys(
  decofile: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decofile)) {
    out[normalizeDecoBlockKey(key)] = value;
  }
  return out;
}

/** Resolve a block key against a decofile that may still use legacy encodings. */
export function resolveDecofileBlockKey(
  decofile: Record<string, unknown>,
  blockKey: string,
): string | null {
  const normalized = normalizeDecoBlockKey(blockKey);
  if (Object.hasOwn(decofile, normalized)) return normalized;
  if (Object.hasOwn(decofile, blockKey)) return blockKey;
  for (const key of Object.keys(decofile)) {
    if (normalizeDecoBlockKey(key) === normalized) return key;
  }
  return null;
}
