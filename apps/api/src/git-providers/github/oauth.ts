/**
 * GitHub App user-to-server OAuth: the authorize URL Studio redirects to and
 * the code exchange on the callback.
 *
 * These live on `github.com`, not the REST API host — a GitHub App is
 * registered on exactly one GitHub instance and Studio's is github.com. There
 * is no `scope` parameter: for a GitHub App the user token's reach is the
 * App's permissions intersected with the installation's.
 */

import { GitProviderError } from "../types";
import { GITHUB_TIMEOUT_MS } from "./http";

const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

/** Pure: the URL to send the user to. `state` is the caller's CSRF binding. */
export function githubAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface GithubOAuthTokens {
  accessToken: string;
  /** Present only when the App has user-token expiration enabled. */
  refreshToken: string | null;
  /** Seconds until `accessToken` expires; null for non-expiring tokens. */
  expiresIn: number | null;
  scope: string | null;
  tokenEndpoint: typeof GITHUB_OAUTH_TOKEN_URL;
}

interface TokenResponseJson {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Pure: map the token endpoint's JSON. GitHub answers 200 for OAuth errors
 * (`bad_verification_code`, `incorrect_client_credentials`), so the body,
 * not the status, decides. `status` is echoed into the error for a body that
 * is neither a token nor an error.
 */
export function parseGithubTokenResponse(
  json: unknown,
  status = 200,
): GithubOAuthTokens {
  const body: TokenResponseJson =
    json !== null && typeof json === "object" ? json : {};
  if (typeof body.error === "string") {
    const description =
      typeof body.error_description === "string"
        ? ` (${body.error_description})`
        : "";
    throw new GitProviderError({
      provider: "github",
      status: 400,
      message: `GitHub OAuth code exchange failed: ${body.error}${description}`,
    });
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new GitProviderError({
      provider: "github",
      status,
      message: "GitHub OAuth code exchange returned no access token",
    });
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
    expiresIn:
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
        ? body.expires_in
        : null,
    scope:
      typeof body.scope === "string" && body.scope.length > 0
        ? body.scope
        : null,
    tokenEndpoint: GITHUB_OAUTH_TOKEN_URL,
  };
}

/** `POST /login/oauth/access_token`: trade the callback `code` for tokens. */
export async function exchangeGithubCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GithubOAuthTokens> {
  let res: Response;
  try {
    res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "github",
      status: 0,
      message: `GitHub OAuth code exchange failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new GitProviderError({
      provider: "github",
      status: res.status,
      message: `GitHub OAuth code exchange failed: ${res.status} ${text.slice(0, 300)}`,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new GitProviderError({
      provider: "github",
      status: res.status,
      message: `GitHub OAuth code exchange returned invalid JSON: ${text.slice(0, 300)}`,
      cause,
    });
  }
  return parseGithubTokenResponse(json, res.status);
}
