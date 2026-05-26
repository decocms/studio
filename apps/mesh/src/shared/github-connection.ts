/**
 * GitHub MCP connection helpers — repo-scoped tokens and connection detection.
 */

import { isGithubMcpConnectionUrl } from "./github-mcp-url";

export const GITHUB_MCP_APP_NAME = "mcp-github";
export const GITHUB_MCP_HOST = "api.githubcopilot.com";
export const GITHUB_MCP_PROXY_HOST = "github-mcp.decocms.com";

export interface GithubConnectionRepoScope {
  owner: string;
  name: string;
  url: string;
  repositoryId: number;
  installationId?: number;
}

export function isGithubMcpConnection(connection: {
  app_name?: string | null;
  connection_url?: string | null;
}): boolean {
  if (connection.app_name === GITHUB_MCP_APP_NAME) return true;
  const url = connection.connection_url;
  if (typeof url !== "string" || url.length === 0) return false;
  return isGithubMcpConnectionUrl(url);
}

export function getGithubConnectionRepoScope(
  metadata: Record<string, unknown> | null | undefined,
): GithubConnectionRepoScope | null {
  const githubRepo = metadata?.githubRepo;
  if (!githubRepo || typeof githubRepo !== "object") return null;

  const record = githubRepo as Record<string, unknown>;
  const owner = record.owner;
  const name = record.name;
  const url = record.url;
  const repositoryId = record.repositoryId;

  if (
    typeof owner !== "string" ||
    typeof name !== "string" ||
    typeof url !== "string" ||
    typeof repositoryId !== "number"
  ) {
    return null;
  }

  const installationId = record.installationId;
  return {
    owner,
    name,
    url,
    repositoryId,
    installationId:
      typeof installationId === "number" ? installationId : undefined,
  };
}

export function githubConnectionTitle(owner: string, name: string): string {
  return `GitHub — ${owner}/${name}`;
}

export function encodeMeshOAuthClientState(state: {
  repositoryId?: number;
}): string {
  const json = JSON.stringify(state);
  const base64 = btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `mesh:${base64}`;
}
