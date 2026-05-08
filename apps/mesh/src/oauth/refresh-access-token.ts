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

export interface TokenRefreshResult {
  success: boolean;
  /**
   * `true` only when the OAuth server told us the refresh_token itself is
   * permanently invalid (RFC 6749 §5.2: `400 invalid_grant`). Callers use
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
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorCode: string | undefined;
      let errorDescription: string | undefined;
      try {
        const errorJson = JSON.parse(errorBody);
        errorCode = errorJson.error;
        errorDescription = errorJson.error_description;
      } catch {
        // body wasn't JSON — fall through with undefined codes
      }

      // Only `400 invalid_grant` means the refresh_token is permanently dead.
      // Everything else (5xx, network blips, non-spec status codes) is treated
      // as transient — the cached token should not be deleted.
      const permanent =
        response.status === 400 && errorCode === "invalid_grant";

      console.error("[TokenRefresh] refresh failed", {
        connectionId: token.connectionId,
        tokenEndpoint: token.tokenEndpoint,
        status: response.status,
        errorCode,
        errorDescription,
        permanent,
      });

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
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || token.refreshToken,
      expiresIn: data.expires_in,
      scope: data.scope,
    };
  } catch (error) {
    console.error("[TokenRefresh] network/parse error", {
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
