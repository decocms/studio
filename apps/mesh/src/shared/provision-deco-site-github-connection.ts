import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "@/settings";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import {
  mintFromOctokitToken,
  mintRepoTokenFromDecoGithubApp,
} from "./deco-github-app-token";
import { decoSiteGithubRepo } from "./deco-sites-github";
import {
  DECO_GITHUB_APP_MINT_SOURCE,
  GITHUB_SCOPED_PERMISSIONS,
} from "./github-repo-scope";
import { DEFAULT_MCP_GITHUB_CONNECTION_URL } from "./mcp-github-connection";
import { generatePrefixedId } from "./utils/generate-id";

export async function provisionDecoSiteGithubConnection(params: {
  ctx: StudioContext;
  orgId: string;
  userId: string;
  siteName: string;
}): Promise<{ githubConnId: string; installationId: number | null }> {
  const { ctx, orgId, userId, siteName } = params;
  const settings = getSettings();
  const githubRepo = decoSiteGithubRepo(siteName);

  let minted;
  if (settings.githubAppId && settings.githubAppPrivateKey) {
    minted = await mintRepoTokenFromDecoGithubApp({
      credentials: {
        appId: settings.githubAppId,
        privateKeyPem: settings.githubAppPrivateKey,
      },
      owner: githubRepo.owner,
      repo: githubRepo.name,
      permissions: GITHUB_SCOPED_PERMISSIONS,
    });
  } else if (settings.octokitToken) {
    minted = mintFromOctokitToken(settings.octokitToken);
  } else {
    throw new Error(
      "GitHub is not configured for deco.cx import — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or OCTOKIT_TOKEN)",
    );
  }

  const githubConnId = generatePrefixedId("conn");
  const connectionUrl =
    settings.mcpGithubConnectionUrl ?? DEFAULT_MCP_GITHUB_CONNECTION_URL;

  await ctx.storage.connections.create({
    id: githubConnId,
    organization_id: orgId,
    created_by: userId,
    title: `GitHub: ${githubRepo.owner}/${githubRepo.name}`,
    description: `Repo-scoped GitHub access for ${githubRepo.owner}/${githubRepo.name}`,
    connection_type: "HTTP",
    connection_url: connectionUrl,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    metadata: {
      repoScope: {
        mintSource: DECO_GITHUB_APP_MINT_SOURCE,
        owner: githubRepo.owner,
        repo: githubRepo.name,
        permissions: GITHUB_SCOPED_PERMISSIONS,
      },
      source: "deco.cx-import",
    },
    icon: null,
    app_name: "mcp-github",
    app_id: null,
    tools: null,
    configuration_scopes: null,
  });

  const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
  await tokenStorage.upsert({
    connectionId: githubConnId,
    accessToken: minted.accessToken,
    refreshToken: null,
    scope: null,
    expiresAt: minted.expiresAt,
    clientId: null,
    clientSecret: null,
    tokenEndpoint: null,
  });

  return {
    githubConnId,
    installationId: minted.installationId,
  };
}
