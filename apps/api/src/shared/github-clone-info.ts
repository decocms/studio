/**
 * Authenticated clone URL + git identity from a connection's OAuth token.
 * The token is baked into the URL — `git clone` then stores it on the
 * remote so subsequent fetch/pull/push from inside the sandbox keep
 * working with no further plumbing.
 *
 * The token is baked into the clone URL on each SANDBOX_START (always
 * re-minted for legacy repo-scoped connections). The daemon syncs `origin`
 * when credentials rotate on a resumed sandbox. Falls back to generic
 * identity defaults on /user failure so callers never block on a flaky
 * upstream.
 */

import type { Kysely } from "kysely";
import type { StudioContext } from "../core/studio-context";
import { ensureRepoScopedToken } from "../oauth/github-mint";
import { DownstreamTokenStorage } from "../storage/downstream-token";
import type { Database } from "../storage/types";
import type { CredentialVault } from "../encryption/credential-vault";
import {
  getValidDownstreamAccessToken,
  RECONNECT_ERROR,
} from "../oauth/token-refresh";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import {
  encodeSandboxStartError,
  SANDBOX_START_ERROR_CODES,
} from "@decocms/shared/sandbox-start-errors";

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

export async function ensureGithubCloneToken(params: {
  ctx: StudioContext;
  connectionId: string;
  organizationId: string;
  /** Always re-mint legacy repo-scoped ghs_ tokens (e.g. before git clone). */
  forceRefresh?: boolean;
  onLegacyMintError?: (error: unknown) => void;
}): Promise<void> {
  const connection = await params.ctx.storage.connections.findById(
    params.connectionId,
    params.organizationId,
  );
  const repoScope = connection ? getRepoScope(connection) : null;
  if (!connection || !repoScope?.sourceConnectionId) return;

  try {
    await ensureRepoScopedToken(params.ctx, connection, {
      forceRefresh: params.forceRefresh,
    });
  } catch (error) {
    params.onLegacyMintError?.(error);
  }
}

export async function buildCloneInfo(
  connectionId: string,
  owner: string,
  name: string,
  db: Kysely<Database>,
  vault: CredentialVault,
  opts?: {
    /**
     * Refresh the token when it has less than this many ms of life left.
     * Callers that need a proactively-fresh token (e.g. a periodic refresh of
     * long-lived sandboxes) pass a large value so the token is re-minted well
     * before its ~55min expiry; omit for the default near-expiry buffer.
     */
    bufferMs?: number;
  },
): Promise<GitHubCloneInfo> {
  const tokenStorage = new DownstreamTokenStorage(db, vault);
  const tokenResult = await getValidDownstreamAccessToken({
    connectionId,
    tokenStorage,
    bufferMs: opts?.bufferMs,
  });
  if (!tokenResult.accessToken) {
    throw new Error(
      encodeSandboxStartError(
        SANDBOX_START_ERROR_CODES.githubNotAuthenticated,
        tokenResult.state === "refresh_failed"
          ? RECONNECT_ERROR
          : "No GitHub token found. Ensure the mcp-github connection is authenticated.",
      ),
    );
  }

  const accessToken = tokenResult.accessToken;

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
