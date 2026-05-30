/**
 * Authenticated clone URL + bot git identity from a connection's downstream
 * App installation token. The token is baked into the URL — `git clone`
 * then stores it on the remote so subsequent fetch/pull/push from inside
 * the sandbox keep working with no further plumbing.
 *
 * The token is set once per sandbox. If it expires or is revoked, the
 * sandbox must be destroyed and recreated — studio does not push token
 * updates to running daemons.
 *
 * `buildCloneInfo` makes no GitHub API call: the committer is the Mesh
 * GitHub App bot. `buildAnonymousCloneInfo` covers public-repo clones
 * (no token) and uses a generic identity.
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

const MCP_GITHUB_BOT_NAME = "mcp-github[bot]";
const MCP_GITHUB_BOT_EMAIL = "mcp-github[bot]@users.noreply.github.com";

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

  return {
    cloneUrl,
    gitUserName: MCP_GITHUB_BOT_NAME,
    gitUserEmail: MCP_GITHUB_BOT_EMAIL,
  };
}
