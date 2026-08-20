import type { ConnectionEntity } from "@/sdk";
import {
  findReusableRepoConnection,
  GITHUB_SCOPED_PERMISSIONS,
  isOrgSharedConnection,
  mintRepoTokenWithFallback,
} from "@decocms/shared/github-repo-scope";

type McpCallTool = (req: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

const REFRESH_GRANT_METADATA_ERROR =
  "GitHub MCP did not return refreshable repo grant metadata";

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isHttpTokenEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function normalizeRepositoryId(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

/**
 * The org's repo-scoped GitHub connections, as the collection tool returns
 * them. Narrow on purpose: only what repo identity needs.
 */
type ExistingConnection = {
  id: string;
  status?: string;
  metadata: Record<string, unknown> | null;
};

/**
 * Look for a connection that already covers this repository.
 *
 * ponytail: read-then-create, so two imports of the same repo racing in two
 * tabs can still both create. Rare, self-healing on the next import, and the
 * consumers dedupe on read — a uniqueness constraint would have to live on a
 * value inside the metadata JSON, which is not worth a migration for that.
 */
async function findExistingRepoConnection(params: {
  selfCallTool: McpCallTool;
  appName: string | null | undefined;
  owner: string;
  repo: string;
}): Promise<ExistingConnection | null> {
  const { selfCallTool, appName, owner, repo } = params;
  if (!appName) return null;
  try {
    const res = (await selfCallTool({
      name: "COLLECTION_CONNECTIONS_LIST",
      arguments: {
        where: { field: ["app_name"], operator: "eq", value: appName },
      },
    })) as { structuredContent?: { items?: ExistingConnection[] } };
    const items = res.structuredContent?.items ?? [];
    return findReusableRepoConnection(items, owner, repo);
  } catch (err) {
    // A failed lookup must not block the import: fall through and provision.
    // Worst case we create the duplicate this function exists to avoid.
    console.warn("[github-import] existing repo connection lookup failed", err);
    return null;
  }
}

export async function provisionRepoScopedGithubConnection(params: {
  orgSlug: string;
  sourceConnection: ConnectionEntity;
  installationId: number;
  owner: string;
  repo: string;
  githubCallTool: McpCallTool;
  selfCallTool: McpCallTool;
  /** Mark the connection as available to every agent ("Add repo" flow). */
  orgShared?: boolean;
}): Promise<{ childConnectionId: string; reused: boolean }> {
  const {
    orgSlug,
    sourceConnection,
    installationId,
    owner,
    repo,
    githubCallTool,
    selfCallTool,
    orgShared,
  } = params;

  // One repository, one connection. Reusing skips the mint entirely — the
  // existing connection's grant refreshes itself through the normal token path.
  //
  // A repo imported before `checks:read` was requested keeps its narrower
  // permission set; re-importing no longer widens it. Delete the connection and
  // import again if the PR Checks tab 403s.
  const existing = await findExistingRepoConnection({
    selfCallTool,
    appName: sourceConnection.app_name,
    owner,
    repo,
  });
  if (existing) {
    // "Add repo" on a repo an agent already imported promotes that connection
    // to org-shared rather than minting a second one beside it.
    if (orgShared && !isOrgSharedConnection(existing)) {
      await selfCallTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: {
          id: existing.id,
          data: { metadata: { ...(existing.metadata ?? {}), orgShared: true } },
        },
      });
    }
    return { childConnectionId: existing.id, reused: true };
  }

  type MintResult = {
    isError?: boolean;
    structuredContent?: {
      token?: string;
      expiresAt?: string;
      expiresIn?: unknown;
      refreshToken?: string;
      tokenEndpoint?: string;
      clientId?: string;
      scope?: string;
      repository?: { id?: unknown; owner?: unknown; name?: unknown };
    };
    content?: Array<{ type?: string; text?: string }>;
  };
  // Request the full scoped set, shedding whichever optional read the github-mcp allowlist/installation doesn't grant yet; the stored recipe records the granted set.
  const { result: mintRes, grantedPermissions } =
    await mintRepoTokenWithFallback<MintResult>(
      (permissions) =>
        githubCallTool({
          name: "MINT_REPO_TOKEN",
          arguments: { installationId, owner, repo, permissions },
        }) as Promise<MintResult>,
      GITHUB_SCOPED_PERMISSIONS,
    );
  const minted = mintRes.structuredContent;
  if (mintRes.isError || !minted?.token) {
    const detail = mintRes.content?.find((c) => c.type === "text")?.text;
    throw new Error(
      detail
        ? `Failed to mint a repo-scoped GitHub token: ${detail}`
        : "Failed to mint a repo-scoped GitHub token",
    );
  }
  const refreshToken = nonEmptyString(minted.refreshToken);
  const tokenEndpoint = nonEmptyString(minted.tokenEndpoint);
  const clientId = nonEmptyString(minted.clientId);
  if (!refreshToken || !tokenEndpoint || !clientId) {
    throw new Error(REFRESH_GRANT_METADATA_ERROR);
  }
  if (!isHttpTokenEndpoint(tokenEndpoint)) {
    throw new Error(REFRESH_GRANT_METADATA_ERROR);
  }
  const repositoryOwner = nonEmptyString(minted.repository?.owner);
  const repositoryName = nonEmptyString(minted.repository?.name);
  const repositoryMismatchError =
    "GitHub MCP returned refresh metadata for a different repository";
  if (
    minted.repository?.owner !== undefined &&
    (!repositoryOwner || repositoryOwner.toLowerCase() !== owner.toLowerCase())
  ) {
    throw new Error(repositoryMismatchError);
  }
  if (
    minted.repository?.name !== undefined &&
    (!repositoryName || repositoryName.toLowerCase() !== repo.toLowerCase())
  ) {
    throw new Error(repositoryMismatchError);
  }
  const repositoryId = normalizeRepositoryId(minted.repository?.id);
  const parsedExpiry = minted.expiresAt ? Date.parse(minted.expiresAt) : NaN;
  const expiresIn = Number.isFinite(parsedExpiry)
    ? Math.max(0, Math.floor((parsedExpiry - Date.now()) / 1000))
    : null;
  const mintedExpiresIn =
    typeof minted.expiresIn === "number" &&
    Number.isFinite(minted.expiresIn) &&
    Number.isInteger(minted.expiresIn) &&
    minted.expiresIn > 0
      ? minted.expiresIn
      : null;
  const tokenExpiresIn = mintedExpiresIn ?? expiresIn;

  const createRes = (await selfCallTool({
    name: "COLLECTION_CONNECTIONS_CREATE",
    arguments: {
      data: {
        title: `GitHub: ${owner}/${repo}`,
        description: `Repo-scoped GitHub access for ${owner}/${repo}`,
        icon: sourceConnection.icon,
        app_name: sourceConnection.app_name,
        app_id: sourceConnection.app_id,
        connection_type: sourceConnection.connection_type,
        connection_url: sourceConnection.connection_url,
        metadata: {
          ...(orgShared ? { orgShared: true } : {}),
          repoScope: {
            installationId,
            repositoryId,
            owner,
            repo,
            permissions: grantedPermissions,
            grantProvider: "github-mcp",
          },
        },
      },
    },
  })) as { structuredContent?: unknown };
  const createdConn = (createRes.structuredContent ?? createRes) as {
    item?: { id?: string };
    id?: string;
  };
  const childConnectionId = createdConn.item?.id ?? createdConn.id;
  if (!childConnectionId) {
    throw new Error("Failed to create the repo-scoped GitHub connection");
  }

  const tokenRes = await fetch(
    `/api/${orgSlug}/connections/${childConnectionId}/oauth-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        accessToken: minted.token,
        refreshToken,
        expiresIn: tokenExpiresIn,
        scope: minted.scope ?? null,
        clientId,
        tokenEndpoint,
      }),
    },
  );
  if (!tokenRes.ok) {
    await selfCallTool({
      name: "COLLECTION_CONNECTIONS_DELETE",
      arguments: { id: childConnectionId, force: true },
    }).catch(() => {});
    throw new Error("Failed to persist the repo-scoped token");
  }

  return { childConnectionId, reused: false };
}
