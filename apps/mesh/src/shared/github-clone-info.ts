/**
 * Authenticated clone URL + git identity from a connection's OAuth token.
 * The token is baked into the URL — `git clone` then stores it on the
 * remote so subsequent fetch/pull/push from inside the sandbox keep
 * working with no further plumbing.
 *
 * Repo-scoped child connections carry minted installation tokens (~1h, no
 * refresh token) and are re-minted on demand via MINT_REPO_TOKEN. OAuth
 * org connections use the standard refresh-token path. Running sandboxes can
 * receive updated credentials via sync-git-credentials.
 */

import type { Kysely } from "kysely";
import type { StudioContext } from "../core/studio-context";
import { ensureRepoScopedToken } from "../oauth/github-mint";
import {
  canRefresh,
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
  refreshAndStore,
} from "../oauth/token-refresh";
import { getRepoScope } from "./github-repo-scope";
import { DownstreamTokenStorage } from "../storage/downstream-token";
import type { Database } from "../storage/types";
import type { CredentialVault } from "../encryption/credential-vault";

export interface GitHubCloneInfo {
  cloneUrl: string;
  gitUserName: string;
  gitUserEmail: string;
}

/**
 * Public-repo clone (no token, no /user lookup). Anonymous HTTPS clone works
 * for any public GitHub repo; push back will fail (no creds) but that's the
 * documented constraint of public-clone mode.
 */
export function buildAnonymousCloneInfo(
  owner: string,
  name: string,
): GitHubCloneInfo {
  return {
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    gitUserName: "Deco Studio",
    gitUserEmail: "studio@deco.cx",
  };
}

/**
 * Resolve a fresh GitHub access token for clone/runtime operations.
 * Repo-scoped connections are re-minted on demand; OAuth connections are
 * proactively refreshed when a refresh token is available.
 */
export async function resolveGitHubAccessToken(
  connectionId: string,
  db: Kysely<Database>,
  vault: CredentialVault,
  ctx?: StudioContext,
): Promise<string> {
  const tokenStorage = new DownstreamTokenStorage(db, vault);

  if (ctx?.organization?.id) {
    const connection = await ctx.storage.connections.findById(
      connectionId,
      ctx.organization.id,
    );
    if (connection && getRepoScope(connection)) {
      return ensureRepoScopedToken(ctx, connection);
    }
  }

  const token = await tokenStorage.get(connectionId);
  if (!token) {
    throw new Error(
      "No GitHub token found. Ensure the mcp-github connection is authenticated.",
    );
  }

  if (
    canRefresh(token) &&
    tokenStorage.isExpired(token, PROACTIVE_REFRESH_BUFFER_MS)
  ) {
    const refreshed = await refreshAndStore(token, tokenStorage);
    if (!refreshed) {
      throw new Error(RECONNECT_ERROR);
    }
    return refreshed;
  }

  if (
    !canRefresh(token) &&
    tokenStorage.isExpired(token, PROACTIVE_REFRESH_BUFFER_MS)
  ) {
    throw new Error(RECONNECT_ERROR);
  }

  return token.accessToken;
}

export async function buildCloneInfo(
  connectionId: string,
  owner: string,
  name: string,
  db: Kysely<Database>,
  vault: CredentialVault,
  ctx?: StudioContext,
): Promise<GitHubCloneInfo> {
  const accessToken = await resolveGitHubAccessToken(
    connectionId,
    db,
    vault,
    ctx,
  );

  const cloneUrl = `https://x-access-token:${accessToken}@github.com/${owner}/${name}.git`;

  let gitUserName = "Deco Studio";
  let gitUserEmail = "studio@deco.cx";
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.ok) {
      const user = (await res.json()) as {
        name?: string | null;
        login: string;
        email?: string | null;
      };
      gitUserName = user.name || user.login;
      gitUserEmail = user.email || `${user.login}@users.noreply.github.com`;
    }
  } catch {
    // Fallback to defaults — don't block the caller.
  }

  return { cloneUrl, gitUserName, gitUserEmail };
}
