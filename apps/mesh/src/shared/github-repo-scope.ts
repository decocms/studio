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

/** The repo grant metadata stored at `connection.metadata.repoScope`. */
export interface RepoScopeRecipe {
  /** Legacy org mcp-github connection used to mint before refreshable grants. */
  sourceConnectionId?: string;
  installationId: number;
  repositoryId?: number;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
  grantProvider?: "github-mcp";
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
  if (
    !raw ||
    typeof raw.installationId !== "number" ||
    typeof raw.owner !== "string" ||
    typeof raw.repo !== "string" ||
    raw.owner.length === 0 ||
    raw.repo.length === 0
  ) {
    return null;
  }
  return {
    sourceConnectionId:
      typeof raw.sourceConnectionId === "string"
        ? raw.sourceConnectionId
        : undefined,
    installationId: raw.installationId,
    repositoryId:
      typeof raw.repositoryId === "number" ? raw.repositoryId : undefined,
    owner: raw.owner,
    repo: raw.repo,
    permissions:
      (raw.permissions as Record<string, string> | undefined) ??
      GITHUB_SCOPED_PERMISSIONS,
    grantProvider:
      raw.grantProvider === "github-mcp" ? "github-mcp" : undefined,
  };
}

/**
 * Org-level mcp-github connections (broad user OAuth). Per-agent repo-scoped
 * children carry `metadata.repoScope` and must not be used for listing
 * installations or minting new repo tokens.
 */
export function getOrgGithubConnections<
  T extends { metadata: Record<string, unknown> | null },
>(connections: T[]): T[] {
  return connections.filter((c) => getRepoScope(c) === null);
}
