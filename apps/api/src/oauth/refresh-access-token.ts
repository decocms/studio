/**
 * OAuth Token Refresh Primitive
 *
 * Pure fetch-based refresh of an OAuth access token via the refresh_token
 * grant. Kept in its own module so tests can mock the primitive — callers
 * that route through `refreshAndStore` (in `./token-refresh`) pick up the
 * mock through the module resolver, unlike same-module references which
 * `mock.module` cannot intercept.
 */

import type { DownstreamToken } from "../storage/types";

/**
 * 400 error codes that mean the refresh_token itself is permanently dead, so
 * the cached token must be evicted instead of retried. `invalid_grant` is the
 * RFC 6749 §5.2 standard; `bad_refresh_token` is the non-standard code some
 * servers emit (e.g. the GitHub MCP token endpoint) — without it an expired
 * GitHub token is retried on every request, hammering the token endpoint.
 */
const PERMANENT_REFRESH_ERROR_CODES = new Set([
  "invalid_grant",
  "bad_refresh_token",
]);

/** Bound the outbound refresh call — a hanging token endpoint shouldn't hang the caller. */
const TOKEN_REFRESH_FETCH_TIMEOUT_MS = 10_000;

/**
 * Upper bound (seconds) for `expires_in`. `Date`'s valid range is ±8.64e15ms,
 * so a huge-but-finite `expires_in` (e.g. `1e20`, or a server that returns
 * milliseconds instead of seconds) survives the `Number.isFinite` check but
 * produces an Invalid Date once multiplied by 1000 downstream
 * (`token-refresh.ts`'s `expiresAt`). `isExpired()` fails safe on that and
 * treats the token as permanently expired, so every call re-triggers a
 * refresh against the token endpoint instead of caching the token for its
 * real lifetime. 100 years in seconds is far past any real OAuth token TTL.
 */
const MAX_EXPIRES_IN_SECONDS = 100 * 365 * 24 * 60 * 60;

export interface TokenRefreshResult {
  success: boolean;
  /**
   * `true` only when the OAuth server told us the refresh_token itself is
   * permanently invalid (a `400` with a code in `PERMANENT_REFRESH_ERROR_CODES`,
   * e.g. RFC 6749 §5.2 `invalid_grant`). Callers use
   * this to decide whether to delete the cached token: deleting on transient
   * failures (5xx, network blips, non-spec status codes) silently logs users
   * out and forces a manual reconnect, so we only delete when we're certain.
   */
  permanent?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  error?: string;
  /** HTTP status of the OAuth response, when there was one. */
  status?: number;
  /** OAuth error code from the response body, when present. */
  errorCode?: string;
}

export async function refreshAccessToken(
  token: DownstreamToken,
): Promise<TokenRefreshResult> {
  if (!token.refreshToken) {
    return {
      success: false,
      permanent: false,
      error: "No refresh token available",
    };
  }

  if (!token.tokenEndpoint) {
    return {
      success: false,
      permanent: false,
      error: "No token endpoint available",
    };
  }

  if (!token.clientId) {
    return {
      success: false,
      permanent: false,
      error: "No client ID available",
    };
  }

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: token.clientId,
    });

    if (token.clientSecret) {
      params.set("client_secret", token.clientSecret);
    }

    if (token.scope) {
      params.set("scope", token.scope);
    }

    const response = await fetch(token.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(TOKEN_REFRESH_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorCode: string | undefined;
      let errorDescription: string | undefined;
      try {
        // error/error_description are untrusted server input — narrow with typeof, like access_token below.
        const errorJson = JSON.parse(errorBody);
        if (typeof errorJson.error === "string") errorCode = errorJson.error;
        if (typeof errorJson.error_description === "string") {
          errorDescription = errorJson.error_description;
        }
      } catch {
        // body wasn't JSON — fall through with undefined codes
      }

      // A 400 with a known dead-refresh-token code means it's permanently
      // dead. Everything else (5xx, network blips, non-spec status codes) is
      // treated as transient — the cached token should not be deleted.
      const permanent =
        response.status === 400 &&
        !!errorCode &&
        PERMANENT_REFRESH_ERROR_CODES.has(errorCode);

      // Permanent failures (dead refresh_token) are actionable → error.
      // Transient ones (5xx, non-spec codes like Cloudflare 525) are upstream
      // blips the proxy recovers from → warn. The caller's backoff
      // (refreshAndStore) rate-limits this so a down endpoint logs once per
      // window, not once per request.
      (permanent ? console.error : console.warn)(
        "[TokenRefresh] refresh failed",
        {
          connectionId: token.connectionId,
          tokenEndpoint: token.tokenEndpoint,
          status: response.status,
          errorCode,
          errorDescription,
          permanent,
        },
      );

      return {
        success: false,
        permanent,
        status: response.status,
        errorCode,
        error:
          errorDescription ||
          errorCode ||
          `Token refresh failed: ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      token_type?: string;
      scope?: unknown;
    };

    // access_token is untrusted server input — narrow with typeof, not the cast above.
    if (typeof data.access_token !== "string" || !data.access_token) {
      // Spec-violating 200 (no/non-string access_token) — treat as transient, not silent success.
      console.warn("[TokenRefresh] 200 response missing access_token", {
        connectionId: token.connectionId,
        tokenEndpoint: token.tokenEndpoint,
      });
      return {
        success: false,
        permanent: false,
        status: response.status,
        error: "Token endpoint returned no access_token",
      };
    }

    // expires_in is untrusted server input — reject non-finite/non-positive values.
    let expiresIn: number | undefined;
    if (data.expires_in !== undefined) {
      const parsed = Number(data.expires_in);
      if (
        Number.isFinite(parsed) &&
        parsed > 0 &&
        parsed <= MAX_EXPIRES_IN_SECONDS
      ) {
        expiresIn = parsed;
      } else {
        console.warn("[TokenRefresh] ignoring malformed expires_in", {
          connectionId: token.connectionId,
          tokenEndpoint: token.tokenEndpoint,
          expiresIn: data.expires_in,
        });
      }
    }

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : token.refreshToken,
      expiresIn,
      scope: typeof data.scope === "string" ? data.scope : undefined,
    };
  } catch (error) {
    // Network/parse errors are transient upstream failures → warn (see above).
    console.warn("[TokenRefresh] network/parse error", {
      connectionId: token.connectionId,
      tokenEndpoint: token.tokenEndpoint,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      permanent: false,
      error: error instanceof Error ? error.message : "Token refresh failed",
    };
  }
}
