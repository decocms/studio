/**
 * Authenticated clone URL + git identity from a connection's OAuth token.
 * The token is baked into the URL — `git clone` then stores it on the
 * remote so subsequent fetch/pull/push from inside the sandbox keep
 * working with no further plumbing.
 *
 * The token is set once per sandbox. If it expires or is revoked, the
 * sandbox must be destroyed and recreated — studio does not push token
 * updates to running daemons. Falls back to generic identity defaults on
 * /user failure so callers never block on a flaky upstream.
 */

import type { Kysely } from "kysely";
import { DownstreamTokenStorage } from "../storage/downstream-token";
import type { Database } from "../storage/types";
import type { CredentialVault } from "../encryption/credential-vault";
import {
  canRefresh,
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
  refreshAndStore,
} from "../oauth/token-refresh";

export interface GitHubCloneInfo {
  cloneUrl: string;
  gitUserName: string;
  gitUserEmail: string;
}

export async function buildCloneInfo(
  connectionId: string,
  owner: string,
  name: string,
  db: Kysely<Database>,
  vault: CredentialVault,
): Promise<GitHubCloneInfo> {
  const tokenStorage = new DownstreamTokenStorage(db, vault);
  const token = await tokenStorage.get(connectionId);
  if (!token) {
    throw new Error(
      "No GitHub token found. Ensure the mcp-github connection is authenticated.",
    );
  }

  let accessToken = token.accessToken;

  // Proactive refresh before baking into the clone URL. Mirrors GITHUB_LIST_USER_ORGS.
  if (
    canRefresh(token) &&
    tokenStorage.isExpired(token, PROACTIVE_REFRESH_BUFFER_MS)
  ) {
    const refreshed = await refreshAndStore(token, tokenStorage);
    if (!refreshed) {
      throw new Error(RECONNECT_ERROR);
    }
    accessToken = refreshed;
  }

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
