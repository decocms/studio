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

import type { DownstreamToken } from "../storage/types";
import type { DownstreamTokenStorage } from "../storage/downstream-token";
import { refreshAccessToken } from "./refresh-access-token";

export { refreshAccessToken } from "./refresh-access-token";
export type { TokenRefreshResult } from "./refresh-access-token";

export const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const RECONNECT_ERROR =
  "GitHub token refresh failed — reconnect the mcp-github integration.";

export function canRefresh(token: DownstreamToken): boolean {
  return !!token.refreshToken && !!token.tokenEndpoint && !!token.clientId;
}

export async function refreshAndStore(
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
