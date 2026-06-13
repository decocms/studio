/**
 * OAuth Token Refresh — storage-aware helpers.
 *
 * Wraps `refreshAccessToken` (from `./refresh-access-token`) with policy: a
 * proactive-refresh time buffer, a user-facing reconnect error string, a
 * "can this token even be refreshed" predicate, and a helper that refreshes
 * then persists (or deletes on failure).
 *
 * The primitive lives in a sibling file so that `mock.module` on
 * `./refresh-access-token` intercepts calls made from inside
 * `refreshAndStore` here — same-module references cannot be mocked.
 */

import { exponentialBackoffWithJitter } from "@decocms/std";
import type { DownstreamToken } from "../storage/types";
import type { DownstreamTokenStorage } from "../storage/downstream-token";
import { refreshAccessToken } from "./refresh-access-token";
import { resolveOriginTokenEndpoint } from "./resolve-token-endpoint";

export type { TokenRefreshResult } from "./refresh-access-token";

export const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const RECONNECT_ERROR =
  "GitHub token refresh failed — reconnect the mcp-github integration.";

export function canRefresh(token: DownstreamToken): boolean {
  return !!token.refreshToken && !!token.tokenEndpoint && !!token.clientId;
}

const inflightRefreshes = new Map<string, Promise<string | null>>();

/**
 * Negative-cache for failed refreshes, keyed by connection. Single-flight
 * (`inflightRefreshes`) only collapses *concurrent* refreshes; without this a
 * down token endpoint (e.g. an upstream Cloudflare 525) is re-hit on every
 * *sequential* proxy request — N requests = N network calls + N error logs.
 * After a failure we suppress further attempts for an exponentially growing
 * window so one broken upstream doesn't get hammered (and doesn't spam logs).
 * Cleared on the next successful refresh. A freshly reconnected token is
 * `valid` for ~1h, far past any cooldown, so it never refreshes through here
 * while suppressed — no prod reset needed.
 */
const REFRESH_BACKOFF_BASE_MS = 30_000;
const REFRESH_BACKOFF_CAP_MS = 5 * 60 * 1000;
const refreshBackoff = new Map<
  string,
  { attempt: number; nextAttemptAt: number }
>();

/** Drop the suppression window for a connection (or all). Test/reconnect hook. */
export function clearRefreshBackoff(connectionId?: string): void {
  if (connectionId) refreshBackoff.delete(connectionId);
  else refreshBackoff.clear();
}

async function refreshAndStoreOnce(
  token: DownstreamToken,
  tokenStorage: DownstreamTokenStorage,
): Promise<string | null> {
  const result = await refreshAccessToken(token);
  if (!result.success || !result.accessToken) {
    // Only delete the cached row when the OAuth server told us the
    // refresh_token is permanently invalid (RFC 6749: 400 invalid_grant).
    // Transient failures (5xx, network, parse errors, non-spec status codes)
    // must not nuke the user's auth — that turns every blip in the upstream
    // OAuth server into a forced manual reconnect.
    if (result.permanent === true) {
      await tokenStorage.delete(token.connectionId);
    }
    return null;
  }
  await tokenStorage.upsert({
    connectionId: token.connectionId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? token.refreshToken,
    scope: result.scope ?? token.scope,
    expiresAt: result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000)
      : null,
    clientId: token.clientId,
    clientSecret: token.clientSecret,
    tokenEndpoint: token.tokenEndpoint,
  });
  return result.accessToken;
}

export function refreshAndStore(
  token: DownstreamToken,
  tokenStorage: DownstreamTokenStorage,
): Promise<string | null> {
  const existing = inflightRefreshes.get(token.connectionId);
  if (existing) return existing;

  const backoff = refreshBackoff.get(token.connectionId);
  if (backoff && Date.now() < backoff.nextAttemptAt) {
    // Still inside the suppression window from a recent failure — skip the
    // network call (and its log) and report failure to the caller as usual.
    return Promise.resolve(null);
  }

  const refresh = refreshAndStoreOnce(token, tokenStorage)
    .then((accessToken) => {
      if (accessToken) {
        refreshBackoff.delete(token.connectionId);
      } else {
        const attempt = refreshBackoff.get(token.connectionId)?.attempt ?? 0;
        const delay = exponentialBackoffWithJitter(
          REFRESH_BACKOFF_CAP_MS,
          REFRESH_BACKOFF_BASE_MS,
          attempt,
          2,
          0.5,
        );
        refreshBackoff.set(token.connectionId, {
          attempt: attempt + 1,
          nextAttemptAt: Date.now() + delay,
        });
      }
      return accessToken;
    })
    .finally(() => {
      inflightRefreshes.delete(token.connectionId);
    });
  inflightRefreshes.set(token.connectionId, refresh);
  return refresh;
}

export type ValidDownstreamAccessTokenResult =
  | { state: "missing"; accessToken: null }
  | { state: "valid"; accessToken: string }
  | { state: "refreshed"; accessToken: string }
  | { state: "refresh_failed"; accessToken: null }
  | { state: "expired_without_refresh"; accessToken: null };

export async function getValidDownstreamAccessToken(params: {
  connectionId: string;
  connectionUrl?: string | null;
  tokenStorage: DownstreamTokenStorage;
  bufferMs?: number;
}): Promise<ValidDownstreamAccessTokenResult> {
  const { connectionId, connectionUrl, tokenStorage } = params;
  const token = await tokenStorage.get(connectionId);
  if (!token) return { state: "missing", accessToken: null };

  const refreshable = canRefresh(token);
  const bufferMs = refreshable
    ? (params.bufferMs ?? PROACTIVE_REFRESH_BUFFER_MS)
    : 0;

  if (!tokenStorage.isExpired(token, bufferMs)) {
    return { state: "valid", accessToken: token.accessToken };
  }

  if (!refreshable) {
    await tokenStorage.delete(connectionId);
    return { state: "expired_without_refresh", accessToken: null };
  }

  let tokenEndpoint = token.tokenEndpoint;
  if (connectionUrl && tokenEndpoint?.includes("/oauth-proxy/")) {
    const originEndpoint = await resolveOriginTokenEndpoint(connectionUrl);
    if (originEndpoint) tokenEndpoint = originEndpoint;
  }

  const accessToken = await refreshAndStore(
    { ...token, tokenEndpoint },
    tokenStorage,
  );
  if (!accessToken) return { state: "refresh_failed", accessToken: null };
  return { state: "refreshed", accessToken };
}
