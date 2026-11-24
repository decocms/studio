/**
 * A browser can keep an error response for a hashed chunk in its HTTP cache
 * (seen as a 404 served with `deliveryType: "cache"` after a rollout). The
 * URL never changes, so every reload replays the 404, the dynamic import
 * fails again, and the user is stuck on "New version available".
 *
 * Re-fetching with `cache: "reload"` skips the cache and overwrites the bad
 * entry, so the next reload gets the real file.
 */

/** Same-origin `/assets/` URLs this page got an error status for. */
export function failedAssetUrls(
  // `responseStatus` is missing where unsupported (Safari): no-op there.
  entries: readonly { name: string; responseStatus?: number }[],
  origin: string,
): string[] {
  const urls = new Set<string>();
  for (const { name, responseStatus = 0 } of entries) {
    if (responseStatus < 400) continue;
    const url = new URL(name, origin);
    if (url.origin === origin && url.pathname.startsWith("/assets/")) {
      urls.add(url.href);
    }
  }
  return [...urls];
}

/** Overwrite cached error responses for chunks; never throws, max ~3s. */
async function evictFailedAssets(): Promise<void> {
  try {
    const entries = performance.getEntriesByType("resource");
    await Promise.all(
      failedAssetUrls(entries, location.origin).map((url) =>
        fetch(url, { cache: "reload", signal: AbortSignal.timeout(3000) })
          // Read the body to the end: a cancelled stream may not be cached.
          .then((res) => res.arrayBuffer())
          .catch(() => {}),
      ),
    );
  } catch {
    // Best effort: the reload still happens.
  }
}

/** Evict cached chunk errors, then reload. */
export function reloadEvictingFailedAssets(): void {
  void evictFailedAssets().finally(() => window.location.reload());
}
