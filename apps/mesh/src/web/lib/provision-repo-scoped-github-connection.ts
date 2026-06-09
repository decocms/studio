import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { GITHUB_SCOPED_PERMISSIONS } from "@/shared/github-repo-scope";

type McpCallTool = (req: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export async function provisionRepoScopedGithubConnection(params: {
  orgSlug: string;
  sourceConnection: ConnectionEntity;
  installationId: number;
  owner: string;
  repo: string;
  githubCallTool: McpCallTool;
  selfCallTool: McpCallTool;
}): Promise<{ childConnectionId: string }> {
  const {
    orgSlug,
    sourceConnection,
    installationId,
    owner,
    repo,
    githubCallTool,
    selfCallTool,
  } = params;

  const mintRes = (await githubCallTool({
    name: "MINT_REPO_TOKEN",
    arguments: {
      installationId,
      owner,
      repo,
      permissions: GITHUB_SCOPED_PERMISSIONS,
    },
  })) as {
    isError?: boolean;
    structuredContent?: { token?: string; expiresAt?: string };
    content?: Array<{ type?: string; text?: string }>;
  };
  const minted = mintRes.structuredContent;
  if (mintRes.isError || !minted?.token) {
    const detail = mintRes.content?.find((c) => c.type === "text")?.text;
    throw new Error(
      detail
        ? `Failed to mint a repo-scoped GitHub token: ${detail}`
        : "Failed to mint a repo-scoped GitHub token",
    );
  }
  const parsedExpiry = minted.expiresAt ? Date.parse(minted.expiresAt) : NaN;
  const expiresIn = Number.isFinite(parsedExpiry)
    ? Math.max(0, Math.floor((parsedExpiry - Date.now()) / 1000))
    : null;

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
          repoScope: {
            sourceConnectionId: sourceConnection.id,
            installationId,
            owner,
            repo,
            permissions: GITHUB_SCOPED_PERMISSIONS,
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
      body: JSON.stringify({ accessToken: minted.token, expiresIn }),
    },
  );
  if (!tokenRes.ok) {
    await selfCallTool({
      name: "COLLECTION_CONNECTIONS_DELETE",
      arguments: { id: childConnectionId, force: true },
    }).catch(() => {});
    throw new Error("Failed to persist the repo-scoped token");
  }

  return { childConnectionId };
}
