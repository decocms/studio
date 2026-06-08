/**
 * Server-side GitHub App token minting for hosted deco-sites/* repositories.
 *
 * Mirrors admin's getRepoTokenFromAppInstallation — no user OAuth required when
 * GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (or OCTOKIT_TOKEN fallback) are set.
 */

import { importPKCS8, SignJWT } from "jose";
import { GITHUB_SCOPED_PERMISSIONS } from "./github-repo-scope";

const GITHUB_API = "https://api.github.com";

export interface DecoGithubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface MintedGithubToken {
  accessToken: string;
  expiresAt: Date | null;
  installationId: number | null;
}

export function normalizeGithubAppPrivateKey(pem: string): string {
  return pem.replace(/\\n/g, "\n");
}

export async function signGithubAppJwt(
  credentials: DecoGithubAppCredentials,
): Promise<string> {
  const key = await importPKCS8(
    normalizeGithubAppPrivateKey(credentials.privateKeyPem),
    "RS256",
  );
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 550)
    .setIssuer(credentials.appId)
    .sign(key);
}

export async function fetchRepoInstallationId(
  jwt: string,
  owner: string,
  repo: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchFn(
    `${GITHUB_API}/repos/${owner}/${repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub installation lookup failed (${res.status})`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

export async function createInstallationRepoToken(
  jwt: string,
  installationId: number,
  repo: string,
  permissions: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<MintedGithubToken> {
  const res = await fetchFn(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repositories: [repo], permissions }),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub installation token mint failed (${res.status})`);
  }
  const data = (await res.json()) as {
    token: string;
    expires_at?: string;
  };
  return {
    accessToken: data.token,
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    installationId,
  };
}

export async function mintRepoTokenFromDecoGithubApp(params: {
  credentials: DecoGithubAppCredentials;
  owner: string;
  repo: string;
  permissions?: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<MintedGithubToken> {
  const {
    credentials,
    owner,
    repo,
    permissions = GITHUB_SCOPED_PERMISSIONS,
    fetchFn = fetch,
  } = params;
  const jwt = await signGithubAppJwt(credentials);
  const installationId = await fetchRepoInstallationId(
    jwt,
    owner,
    repo,
    fetchFn,
  );
  return createInstallationRepoToken(
    jwt,
    installationId,
    repo,
    permissions,
    fetchFn,
  );
}

export function mintFromOctokitToken(octokitToken: string): MintedGithubToken {
  return {
    accessToken: octokitToken,
    expiresAt: null,
    installationId: null,
  };
}
