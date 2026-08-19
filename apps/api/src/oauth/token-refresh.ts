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

import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import type { DownstreamToken } from "../storage/types";
import type { DownstreamTokenStorage } from "../storage/downstream-token";
import { refreshAccessToken } from "./refresh-access-token";
import { resolveOriginTokenEndpoint } from "./resolve-token-endpoint";

export type { TokenRefreshResult } from "./refresh-access-token";

export const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// GitHub App installation tokens (ghs_) always expire in ~1 hour and have no
// refresh_token. This constant is the fallback lifetime used when MINT_REPO_TOKEN
// omits expiresAt, giving a 10-minute safety margin before GitHub's 60-min limit.
export const GHS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;

export const RECONNECT_ERROR =
  "GitHub token refresh failed — reconnect the mcp-github integration.";

export function canRefresh(token: DownstreamToken): boolean {
  return !!token.refreshToken && !!token.tokenEndpoint && !!token.clientId;
}

/**
 * Should we re-discover the origin token endpoint from the connection's
 * *current* metadata instead of trusting the stored one? Yes when the stored
 * value is unusable for a direct server-side refresh:
 *   - it routes back through our own oauth-proxy (`/oauth-proxy/:id/token`), or
 *   - its host no longer matches the connection's host — a stale endpoint
 *     captured at authorize time. Deco-serverless integrations were authorized
 *     against the `*.decocache.com` canonical host, which now fails the
 *     Cloudflare→origin TLS handshake (HTTP 525), while the connection itself
 *     lives on the working `*.deco.site` alias.
 *
 * Re-resolution is best-effort and fail-safe: a legitimate external IdP (host
 * intentionally differs from the connection) re-discovers the same correct
 * endpoint via metadata, and a failed discovery keeps the stored value. A
 * successful refresh persists the re-resolved endpoint, so the row self-heals.
 */
export function needsTokenEndpointReresolution(
  tokenEndpoint: string,
  connectionUrl: string,
): boolean {
  if (tokenEndpoint.includes("/oauth-proxy/")) return true;
  try {
    return new URL(tokenEndpoint).host !== new URL(connectionUrl).host;
  } catch {
    return false;
  }
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
): Promise<{ accessToken: string | null; permanent: boolean }> {
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
    return { accessToken: null, permanent: result.permanent === true };
  }
  await tokenStorage.upsert({
    connectionId: token.connectionId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? token.refreshToken,
    scope: result.scope ?? token.scope,
    expiresAt:
      result.expiresIn === undefined
        ? null
        : new Date(Date.now() + result.expiresIn * 1000),
    clientId: token.clientId,
    clientSecret: token.clientSecret,
    tokenEndpoint: token.tokenEndpoint,
  });
  return { accessToken: result.accessToken, permanent: false };
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
    .then(({ accessToken, permanent }) => {
      if (accessToken || permanent) {
        // Permanent failure already deleted the token row — no backoff to arm.
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

/**
 * `force` skips the freshness check entirely — for callers that learned the
 * token is dead from the upstream (a 401) rather than from its expiry. It must
 * not be expressed as a huge `bufferMs`: `isExpired` reports a null-expiry row
 * as fresh before it ever consults the buffer, so such a row would hand back
 * the very token the upstream just rejected.
 */
export async function getValidDownstreamAccessToken(params: {
  connectionId: string;
  connectionUrl?: string | null;
  tokenStorage: DownstreamTokenStorage;
  bufferMs?: number;
  force?: boolean;
}): Promise<ValidDownstreamAccessTokenResult> {
  const { connectionId, connectionUrl, tokenStorage, force } = params;
  const token = await tokenStorage.get(connectionId);
  if (!token) return { state: "missing", accessToken: null };

  const refreshable = canRefresh(token);
  const bufferMs = refreshable
    ? (params.bufferMs ?? PROACTIVE_REFRESH_BUFFER_MS)
    : 0;
  const expired = tokenStorage.isExpired(token, bufferMs);

  if (!force && !expired) {
    return { state: "valid", accessToken: token.accessToken };
  }

  if (!refreshable) {
    // A forced call on a live token must not delete the user's credential.
    if (expired) await tokenStorage.delete(connectionId);
    return { state: "expired_without_refresh", accessToken: null };
  }

  let tokenEndpoint = token.tokenEndpoint;
  if (
    connectionUrl &&
    tokenEndpoint &&
    needsTokenEndpointReresolution(tokenEndpoint, connectionUrl)
  ) {
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
