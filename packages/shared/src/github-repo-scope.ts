/**
 * Repo-scoped GitHub connection — shared, pure helpers.
 *
 * A "repo-scoped" mcp-github connection is a child connection for exactly one
 * repository, shared by every agent that imported that repository (see
 * `findReusableRepoConnection`). New refreshable repo children persist a GitHub
 * MCP repo grant in downstream_tokens and refresh through the normal
 * OAuth-shaped token path. Legacy repo children may still carry
 * `sourceConnectionId` so callers can mint with deco/mcp-github's
 * MINT_REPO_TOKEN during compatibility flows. The repo grant metadata lives on
 * the connection's metadata under `repoScope`; its presence marks the
 * connection as disposable once its LAST holder goes away, not as any single
 * agent's to tear down.
 *
 * Pure module (no DB / network / node deps) so both the server
 * (oauth/github-mint) and the web import flow (github-repo-picker) can import it.
 */

/**
 * Least-privilege permission set minted for an imported agent's repo token.
 *
 * `checks: read` lets the PR panel's Checks tab read CI check runs
 * (`GET /commits/{sha}/check-runs`); `deployments: read` lets it read a PR's
 * preview URL from the GitHub Deployments API (`GET /repos/{o}/{r}/deployments`
 * + `/statuses`, via `GET_PREVIEW_DEPLOYMENT`) — the ONLY place a VTEX FastStore
 * WebOps preview is published (not a commit-status target_url, not a bot
 * comment). Without each, the GitHub App installation token gets `403 Resource
 * not accessible by integration` on that endpoint. The backing GitHub App must
 * also grant them (and github-mcp's mint allowlist must permit them) or the mint
 * is rejected — see OPTIONAL_MINT_PERMISSIONS / mintRepoTokenWithFallback, which
 * sheds them one at a time so an installation that grants neither still mints a
 * working code token.
 */
export const GITHUB_SCOPED_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  deployments: "read",
};

/**
 * The read permissions an installation (or github-mcp's mint allowlist) may not
 * grant yet, ordered MOST-DROPPABLE FIRST. `mintRepoTokenWithFallback` sheds
 * them one at a time on a permission rejection, so an installation that has the
 * long-standing `checks` but not the newer `deployments` keeps checks. Anything
 * NOT listed here is required and never dropped — a rejection for one of those
 * surfaces instead of being silently downgraded.
 *
 * Every entry must also appear in GITHUB_SCOPED_PERMISSIONS (asserted in the
 * unit test): this list marks which of the requested permissions are droppable,
 * it does not add new ones.
 */
export const OPTIONAL_MINT_PERMISSIONS = ["deployments", "checks"] as const;

/**
 * Detects a mint rejection caused specifically by requesting a permission the
 * installation/allowlist doesn't grant, so callers can retry without it. Two
 * distinct upstreams produce this:
 *   1. github-mcp's own allowlist predating a permission — it hard-rejects with
 *      `Permission "<name>" is not allowed` (deploy-window skew).
 *   2. GitHub itself, when the App installation hasn't granted it — the mint
 *      422s, surfaced as `...the requested permissions exceed what the GitHub
 *      App was granted`.
 * The allowlist form matches ONLY for an OPTIONAL permission (a required one
 * being rejected is a real misconfiguration, not something to silently drop);
 * the generic 422 doesn't name the offending permission, so the ladder degrades
 * by dropping optionals in order until the mint succeeds.
 */
export function isPermissionRejected(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const optional = OPTIONAL_MINT_PERMISSIONS.join("|");
  return (
    new RegExp(`permission\\s+"?(?:${optional})"?\\s+is not allowed`, "i").test(
      message,
    ) || /permissions exceed what the github app/i.test(message)
  );
}

/** Minimal shape of a github-mcp MINT_REPO_TOKEN result the fallback inspects. */
export interface MintToolResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * `base` plus every OPTIONAL_MINT_PERMISSIONS key at `read`. Used by the timer
 * re-mint path to request the current optionals on top of a stored recipe, so a
 * legacy connection self-heals into `checks`/`deployments` on its next ~1h
 * re-mint without a re-import.
 */
export function withOptionalReadPermissions(
  base: Record<string, string>,
): Record<string, string> {
  const out = { ...base };
  for (const permission of OPTIONAL_MINT_PERMISSIONS) {
    out[permission] = "read";
  }
  return out;
}

/**
 * Mint a repo token requesting `desiredPermissions`, transparently shedding one
 * OPTIONAL_MINT_PERMISSIONS entry at a time (in list order) whenever the mint is
 * rejected specifically for exceeding what the installation/allowlist grants —
 * so importing/refreshing keeps working on an installation that hasn't been
 * re-approved for the newer reads. Base (required) permissions are never
 * dropped, so a rejection for one of those (or any unrelated error) surfaces
 * once the optionals are gone. Single-sources the retry ladder shared by the
 * web provision flow and the server re-mint path.
 *
 * `callTool` performs the actual MINT_REPO_TOKEN call with a given permission
 * map; the returned `grantedPermissions` is whichever set ultimately succeeded
 * (or was last attempted) so callers can persist the truth.
 *
 * Note: callers that re-mint on a timer (github-mint) always re-add the
 * optionals via withOptionalReadPermissions, so a connection whose installation
 * will never grant them pays extra mints each cycle. That's the deliberate cost
 * of picking up a later-granted permission without a re-import; provision
 * persists the granted set and does not re-probe.
 */
export async function mintRepoTokenWithFallback<R extends MintToolResultLike>(
  callTool: (permissions: Record<string, string>) => Promise<R>,
  desiredPermissions: Record<string, string>,
): Promise<{ result: R; grantedPermissions: Record<string, string> }> {
  let permissions: Record<string, string> = { ...desiredPermissions };
  for (;;) {
    const result = await callTool(permissions);
    if (!result.isError) {
      return { result, grantedPermissions: permissions };
    }
    const text = result.content?.find((c) => c.type === "text")?.text;
    const droppable = OPTIONAL_MINT_PERMISSIONS.find((p) => p in permissions);
    if (!droppable || !isPermissionRejected(text)) {
      return { result, grantedPermissions: permissions };
    }
    const { [droppable]: _dropped, ...rest } = permissions;
    permissions = rest;
  }
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

/** GitHub treats owner/repo case-insensitively; repo identity must too. */
const repoIdentity = (owner: string, repo: string) =>
  `${owner}/${repo}`.toLowerCase();

/**
 * The distinct `owner/name` repos an org can reach — active repo-scoped
 * connections, deduped by case-insensitive identity (keeping each repo's
 * first-seen display casing). The option set for repo pickers/filters.
 */
export function listRepoScopeLabels<
  T extends { status?: string; metadata: Record<string, unknown> | null },
>(connections: T[] | undefined | null): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const connection of connections ?? []) {
    if (connection.status !== "active") continue;
    const scope = getRepoScope(connection);
    if (scope === null) continue;
    const key = repoIdentity(scope.owner, scope.repo);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(`${scope.owner}/${scope.repo}`);
  }
  return labels;
}

/**
 * An existing connection that already grants access to `owner/repo`, or null.
 *
 * One repository should have ONE connection. Provisioning used to mint and
 * create unconditionally, so importing a repo org-wide and then again from an
 * agent left two connections behind for the same repository — which every
 * consumer of `getRepoScope` then had to dedupe (and mostly didn't: the task
 * board read the duplicate as "which repo?" and refused to run).
 *
 * The org-shared connection wins when both exist: it outlives any single agent,
 * so reusing it can't hand an agent a connection that disappears with a
 * teammate's agent.
 */
export function findReusableRepoConnection<
  T extends { status?: string; metadata: Record<string, unknown> | null },
>(connections: T[] | undefined | null, owner: string, repo: string): T | null {
  const wanted = repoIdentity(owner, repo);
  const matches = (connections ?? []).filter((connection) => {
    if (connection.status && connection.status !== "active") return false;
    const scope = getRepoScope(connection);
    return scope !== null && repoIdentity(scope.owner, scope.repo) === wanted;
  });
  return matches.find(isOrgSharedConnection) ?? matches[0] ?? null;
}
