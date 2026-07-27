/**
 * Repo-scoped GitHub connection — shared, pure helpers.
 *
 * A "repo-scoped" mcp-github connection is a per-agent child connection for
 * exactly one repository. New refreshable repo children persist a GitHub MCP
 * repo grant in downstream_tokens and refresh through the normal OAuth-shaped
 * token path. Legacy repo children may still carry `sourceConnectionId` so
 * callers can mint with deco/mcp-github's MINT_REPO_TOKEN during compatibility
 * flows. The repo grant metadata lives on the connection's metadata under
 * `repoScope`; its presence also marks the connection as a disposable per-agent
 * child for teardown.
 *
 * Pure module (no DB / network / node deps) so both the server
 * (oauth/github-mint) and the web import flow (github-repo-picker) can import it.
 */

/**
 * Least-privilege permission set minted for an imported agent's repo token.
 *
 * `checks: read` lets the PR panel's Checks tab read CI check runs
 * (`GET /commits/{sha}/check-runs`); without it the GitHub App installation
 * token gets `403 Resource not accessible by integration`. The backing GitHub
 * App must also grant Checks (read) or the mint fails with 422.
 */
export const GITHUB_SCOPED_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  checks: "read",
};

/**
 * Detects a mint failure caused specifically by requesting `checks`, so callers
 * can retry without it. Two distinct upstreams produce this:
 *   1. github-mcp's own allowlist predating `checks` — it hard-rejects with
 *      `Permission "checks" is not allowed` (deploy-window skew).
 *   2. GitHub itself, when the App installation hasn't granted Checks — the
 *      mint 422s, surfaced as `...the requested permissions exceed what the
 *      GitHub App was granted`.
 * Either way the safe move is a checks-less retry; if the real problem were
 * unrelated (e.g. repo not in the installation), that retry fails identically.
 */
export function isChecksPermissionRejected(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return (
    /permission\s+"?checks"?\s+is not allowed/i.test(message) ||
    /permissions exceed what the github app/i.test(message)
  );
}

/** A copy of a permission map with the `checks` key removed. */
export function permissionsWithoutChecks(
  permissions: Record<string, string>,
): Record<string, string> {
  const { checks: _checks, ...rest } = permissions;
  return rest;
}

/** Minimal shape of a github-mcp MINT_REPO_TOKEN result the fallback inspects. */
export interface MintToolResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * Mint a repo token requesting `checks:read` on top of `basePermissions`, and
 * transparently retry WITHOUT `checks` when the mint is rejected specifically
 * for it (github-mcp allowlist skew, or an installation that hasn't granted
 * Checks → 422). Single-sources the retry decision shared by the web provision
 * flow and the server re-mint path.
 *
 * `callTool` performs the actual MINT_REPO_TOKEN call with a given permission
 * map; the returned `grantedPermissions` is whichever set was ultimately
 * requested (with or without `checks`) so callers can persist the truth.
 *
 * Note: callers that re-mint on a timer (github-mint) always re-add `checks`
 * here, so a connection whose installation will never grant Checks pays a
 * second mint each cycle. That's the deliberate cost of picking up a
 * later-granted Checks without a re-import; provision persists the granted set
 * and does not re-probe.
 */
export async function mintRepoTokenWithChecksFallback<
  R extends MintToolResultLike,
>(
  callTool: (permissions: Record<string, string>) => Promise<R>,
  basePermissions: Record<string, string>,
): Promise<{ result: R; grantedPermissions: Record<string, string> }> {
  const desiredPermissions = { ...basePermissions, checks: "read" };
  const result = await callTool(desiredPermissions);
  if (
    result.isError &&
    isChecksPermissionRejected(
      result.content?.find((c) => c.type === "text")?.text,
    )
  ) {
    const grantedPermissions = permissionsWithoutChecks(basePermissions);
    return { result: await callTool(grantedPermissions), grantedPermissions };
  }
  return { result, grantedPermissions: desiredPermissions };
}

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

function parsePermissions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return GITHUB_SCOPED_PERMISSIONS;
  }
  const permissions = raw as Record<string, unknown>;
  if (Object.values(permissions).some((value) => typeof value !== "string")) {
    return GITHUB_SCOPED_PERMISSIONS;
  }
  return permissions as Record<string, string>;
}

function parsePositiveInteger(raw: unknown): number | undefined {
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    return undefined;
  }
  return raw;
}

/**
 * Read + validate the repoScope recipe from a connection's metadata.
 * Returns null when the connection is not a repo-scoped child (or the recipe is
 * malformed) so callers can branch on it safely.
 */
export function getRepoScope(connection: {
  metadata?: Record<string, unknown> | null;
}): RepoScopeRecipe | null {
  const raw = connection.metadata?.repoScope as
    | Partial<RepoScopeRecipe>
    | undefined;
  if (
    !raw ||
    typeof raw.installationId !== "number" ||
    !Number.isFinite(raw.installationId) ||
    !Number.isInteger(raw.installationId) ||
    raw.installationId <= 0 ||
    typeof raw.owner !== "string" ||
    typeof raw.repo !== "string" ||
    raw.owner.length === 0 ||
    raw.repo.length === 0
  ) {
    return null;
  }
  const repositoryId = parsePositiveInteger(raw.repositoryId);
  return {
    sourceConnectionId:
      typeof raw.sourceConnectionId === "string"
        ? raw.sourceConnectionId
        : undefined,
    installationId: raw.installationId,
    repositoryId,
    owner: raw.owner,
    repo: raw.repo,
    permissions: parsePermissions(raw.permissions),
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
>(connections: T[] | undefined | null): T[] {
  return (connections ?? []).filter((c) => getRepoScope(c) === null);
}

/**
 * An org-shared repo connection ("Add repo" in the sidebar): a repo-scoped
 * child that is deliberately NOT bound to a single agent — it's injected into
 * every agent's toolset. Distinct from the per-agent import child, which also
 * has `repoScope` but no `orgShared` flag and stays private to its agent.
 */
export function isOrgSharedConnection(connection: {
  metadata: Record<string, unknown> | null;
}): boolean {
  return connection.metadata?.orgShared === true;
}
