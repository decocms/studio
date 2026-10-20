/**
 * Bitbucket Cloud OAuth 2.0 authorization-code flow.
 *
 * URL building is pure so the routes can unit-test the redirect they send the
 * browser to. `exchangeBitbucketCode` is the one network call; Bitbucket
 * issues a short-lived access token (2h) plus a refresh token, so callers
 * persist the grant and the shared refresh helper renews it.
 *
 * Two things differ from GitLab's flow. Scopes are fixed on the OAuth consumer
 * when it is registered, so the authorize URL carries none — the consumer
 * needs `account`, `repository:write` and `pullrequest:write` (and `email` for
 * commit identity). And Bitbucket's token endpoint answers `scopes`, plural.
 * It accepts the client credentials in the POST body as well as as HTTP
 * Basic; the body is used here because that is the only form the shared
 * refresh helper (`oauth/refresh-access-token.ts`) sends, and an exchange
 * that works must not be followed by a refresh that cannot.
 */

import { GitProviderError } from "../types";
import { BITBUCKET_HOST } from "./env";

export interface BitbucketAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
}

export function bitbucketAuthorizeUrl(
  params: BitbucketAuthorizeUrlParams,
): string {
  const url = new URL(`https://${BITBUCKET_HOST}/site/oauth2/authorize`);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function bitbucketTokenEndpoint(): string {
  return `https://${BITBUCKET_HOST}/site/oauth2/access_token`;
}

export interface ExchangeBitbucketCodeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export interface BitbucketTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until `accessToken` expires, as Bitbucket reported it. */
  expiresIn: number | null;
  /** Space-separated, as the shared grant store expects. */
  scope: string | null;
  tokenEndpoint: string;
}

interface BitbucketTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scopes?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const TOKEN_TIMEOUT_MS = 15_000;

export async function exchangeBitbucketCode(
  params: ExchangeBitbucketCodeParams,
): Promise<BitbucketTokenGrant> {
  const tokenEndpoint = bitbucketTokenEndpoint();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  let res: Response;
  try {
    res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: 0,
      message: `Bitbucket token exchange failed: ${describeCause(cause)}`,
      cause,
    });
  }

  const json = (await res
    .json()
    .catch(() => null)) as BitbucketTokenResponse | null;
  if (!res.ok || !json || typeof json.error === "string") {
    const detail =
      json && typeof json.error_description === "string"
        ? json.error_description
        : json && typeof json.error === "string"
          ? json.error
          : res.statusText;
    throw new GitProviderError({
      provider: "bitbucket",
      status: res.status,
      message: `Bitbucket token exchange failed (${res.status}): ${detail}`,
    });
  }
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: res.status,
      message: "Bitbucket token exchange returned no access_token",
    });
  }

  return {
    accessToken: json.access_token,
    refreshToken:
      typeof json.refresh_token === "string" && json.refresh_token
        ? json.refresh_token
        : null,
    expiresIn:
      typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
        ? json.expires_in
        : null,
    scope: typeof json.scopes === "string" ? json.scopes : null,
    tokenEndpoint,
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
