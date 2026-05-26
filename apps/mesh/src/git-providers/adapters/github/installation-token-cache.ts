/**
 * In-process cache for GitHub installation access tokens.
 *
 * GitHub mints installation tokens that live for ~1 hour. Re-minting on every
 * tool call would (a) burn API quota and (b) add ~200ms of latency. We cache
 * tokens keyed by installation id and refresh ~5 minutes before expiry.
 *
 * In-memory is fine even in multi-instance deployments: tokens are re-mintable
 * any time, so cache misses just cost one extra call to GitHub. We don't need
 * cross-instance consistency.
 */

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry

interface CachedToken {
  token: string;
  /** Absolute ms-since-epoch when the token expires. */
  expiresAt: number;
}

export class InstallationTokenCache {
  private cache = new Map<string, CachedToken>();
  /** De-duplicate concurrent refreshes for the same installation. */
  private inflight = new Map<string, Promise<string>>();

  /**
   * Get a fresh token for `installationId`. Cache hit → returns immediately.
   * Cache miss / near expiry → calls `mint()` (de-duped across concurrent
   * callers for the same installation) and stores the result.
   */
  async get(
    installationId: string,
    mint: () => Promise<{ token: string; expiresAtMs: number }>,
  ): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - REFRESH_BUFFER_MS > Date.now()) {
      return cached.token;
    }

    const existing = this.inflight.get(installationId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const { token, expiresAtMs } = await mint();
        this.cache.set(installationId, { token, expiresAt: expiresAtMs });
        return token;
      } finally {
        this.inflight.delete(installationId);
      }
    })();

    this.inflight.set(installationId, promise);
    return promise;
  }

  /** Force-evict (used after `Unauthorized` responses to force a re-mint). */
  invalidate(installationId: string): void {
    this.cache.delete(installationId);
  }
}
