/**
 * Dev override for the GitHub MCP connection URL.
 *
 * In development, Studio points new GitHub imports at a local Worker
 * (wrangler dev) instead of github-mcp.decocms.com. Set
 * VITE_GITHUB_MCP_URL in apps/mesh/.env.development to change the target.
 */

const DEFAULT_LOCAL_GITHUB_MCP_URL = "http://localhost:8787/api/mcp";

function readViteEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve the HTTP URL used when creating a GitHub MCP connection. */
export function resolveGithubMcpConnectionUrl(
  registryUrl: string | undefined,
): string {
  const override = readViteEnv("VITE_GITHUB_MCP_URL");
  if (override) return override;

  if (import.meta.env.DEV) {
    return DEFAULT_LOCAL_GITHUB_MCP_URL;
  }

  if (!registryUrl) {
    throw new Error("Registry item is missing a remote URL for mcp-github");
  }

  return registryUrl;
}

export function isLocalGithubMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function isGithubMcpConnectionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/mcp")) return false;

    return (
      parsed.hostname === "github-mcp.decocms.com" ||
      parsed.hostname === "api.githubcopilot.com" ||
      isLocalGithubMcpUrl(url)
    );
  } catch {
    return false;
  }
}
