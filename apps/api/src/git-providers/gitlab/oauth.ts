/**
 * GitLab OAuth 2.0 authorization-code flow.
 *
 * URL building is pure so the routes can unit-test the redirect they send the
 * browser to. `exchangeGitlabCode` is the one network call; GitLab issues a
 * short-lived access token (2h) plus a refresh token that rotates on every
 * refresh, so callers must persist the returned `refreshToken` each time.
 */

import { GitProviderError } from "../types";

/** Default scopes: `api` for repository read/write, `read_user` for identity. */
const GITLAB_DEFAULT_SCOPES = ["api", "read_user"] as const;

export interface GitlabAuthorizeUrlParams {
  host: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}

export function gitlabAuthorizeUrl(params: GitlabAuthorizeUrlParams): string {
  const url = new URL(`https://${params.host}/oauth/authorize`);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  url.searchParams.set(
    "scope",
    (params.scopes ?? GITLAB_DEFAULT_SCOPES).join(" "),
  );
  return url.toString();
}

export function gitlabTokenEndpoint(host: string): string {
  return `https://${host}/oauth/token`;
}

export interface ExchangeGitlabCodeParams {
  host: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export interface GitlabTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until `accessToken` expires, as GitLab reported it. */
  expiresIn: number | null;
  scope: string | null;
  tokenEndpoint: string;
}

interface GitlabTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const TOKEN_TIMEOUT_MS = 15_000;

export async function exchangeGitlabCode(
  params: ExchangeGitlabCodeParams,
): Promise<GitlabTokenGrant> {
  const tokenEndpoint = gitlabTokenEndpoint(params.host);
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
      provider: "gitlab",
      status: 0,
      message: `GitLab token exchange failed: ${describeCause(cause)}`,
      cause,
    });
  }

  const json = (await res
    .json()
    .catch(() => null)) as GitlabTokenResponse | null;
  if (!res.ok || !json || typeof json.error === "string") {
    const detail =
      json && typeof json.error_description === "string"
        ? json.error_description
        : json && typeof json.error === "string"
          ? json.error
          : res.statusText;
    throw new GitProviderError({
      provider: "gitlab",
      status: res.status,
      message: `GitLab token exchange failed (${res.status}): ${detail}`,
    });
  }
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new GitProviderError({
      provider: "gitlab",
      status: res.status,
      message: "GitLab token exchange returned no access_token",
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
    scope: typeof json.scope === "string" ? json.scope : null,
    tokenEndpoint,
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
