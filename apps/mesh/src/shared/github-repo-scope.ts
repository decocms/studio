/**
 * Repo-scoped GitHub connection — shared, pure helpers.
 *
 * A "repo-scoped" mcp-github connection is a per-agent child connection whose
 * downstream token is minted (by deco/mcp-github's MINT_REPO_TOKEN) for exactly
 * one repository. The mint "recipe" lives on the connection's metadata under
 * `repoScope`; its presence also marks the connection as a disposable per-agent
 * child for teardown.
 *
 * Pure module (no DB / network / node deps) so both the server
 * (oauth/github-mint) and the web import flow (github-repo-picker) can import it.
 */

/** Least-privilege permission set minted for an imported agent's repo token. */
export const GITHUB_SCOPED_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
};

/** Mint source for per-agent child connections provisioned during deco.cx import. */
export const DECO_GITHUB_APP_MINT_SOURCE = "deco-github-app" as const;

/** The mint recipe stored at `connection.metadata.repoScope`. */
export type McpGithubRepoScopeRecipe = {
  mintSource?: "mcp-github";
  /** Org mcp-github connection (broad user-to-server OAuth) used to mint. */
  sourceConnectionId: string;
  installationId: number;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
};

export type DecoGithubAppRepoScopeRecipe = {
  mintSource: typeof DECO_GITHUB_APP_MINT_SOURCE;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
};

export type RepoScopeRecipe =
  | McpGithubRepoScopeRecipe
  | DecoGithubAppRepoScopeRecipe;

export function isDecoGithubAppRepoScope(
  recipe: RepoScopeRecipe,
): recipe is DecoGithubAppRepoScopeRecipe {
  return recipe.mintSource === DECO_GITHUB_APP_MINT_SOURCE;
}

/**
 * Read + validate the repoScope recipe from a connection's metadata.
 * Returns null when the connection is not a repo-scoped child (or the recipe is
 * malformed) so callers can branch on it safely.
 */
export function getRepoScope(connection: {
  metadata: Record<string, unknown> | null;
}): RepoScopeRecipe | null {
  const raw = connection.metadata?.repoScope as
    | Partial<RepoScopeRecipe>
    | undefined;
  if (!raw || typeof raw.owner !== "string" || typeof raw.repo !== "string") {
    return null;
  }
  if (raw.owner.length === 0 || raw.repo.length === 0) {
    return null;
  }

  const permissions =
    (raw.permissions as Record<string, string> | undefined) ??
    GITHUB_SCOPED_PERMISSIONS;

  if (raw.mintSource === DECO_GITHUB_APP_MINT_SOURCE) {
    return {
      mintSource: DECO_GITHUB_APP_MINT_SOURCE,
      owner: raw.owner,
      repo: raw.repo,
      permissions,
    };
  }

  if (
    typeof raw.sourceConnectionId !== "string" ||
    typeof raw.installationId !== "number"
  ) {
    return null;
  }

  return {
    sourceConnectionId: raw.sourceConnectionId,
    installationId: raw.installationId,
    owner: raw.owner,
    repo: raw.repo,
    permissions,
  };
}
