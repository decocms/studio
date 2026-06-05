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

/** The mint recipe stored at `connection.metadata.repoScope`. */
export interface RepoScopeRecipe {
  /** Org mcp-github connection (broad user-to-server OAuth) used to mint. */
  sourceConnectionId: string;
  installationId: number;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
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
    typeof raw.sourceConnectionId !== "string" ||
    typeof raw.installationId !== "number" ||
    typeof raw.owner !== "string" ||
    typeof raw.repo !== "string" ||
    raw.owner.length === 0 ||
    raw.repo.length === 0
  ) {
    return null;
  }
  return {
    sourceConnectionId: raw.sourceConnectionId,
    installationId: raw.installationId,
    owner: raw.owner,
    repo: raw.repo,
    permissions:
      (raw.permissions as Record<string, string> | undefined) ??
      GITHUB_SCOPED_PERMISSIONS,
  };
}
