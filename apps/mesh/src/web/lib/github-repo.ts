import type { GithubRepo, VirtualMCPEntity } from "@decocms/mesh-sdk/types";

/**
 * Returns the GitHub repo metadata only if its connectionId
 * exists in the Virtual MCP's connections array.
 * Returns null when the metadata is stale (connection removed).
 */
export function getActiveGithubRepo(
  virtualMcp: VirtualMCPEntity | null | undefined,
): GithubRepo | null {
  const repo = virtualMcp?.metadata?.githubRepo;
  if (!repo?.connectionId) return null;

  const hasConnection = virtualMcp?.connections?.some(
    (c) => c.connection_id === repo.connectionId,
  );

  return hasConnection ? repo : null;
}

/**
 * True when the agent has any cloneable repo source — either an
 * OAuth-linked GitHub repo OR a plain public clone URL. Use this to
 * gate preview-tab visibility and VM auto-start. Git-specific features
 * (PR creation, issue triggers) should still use `getActiveGithubRepo`.
 */
export function hasPreviewableRepo(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  if (getActiveGithubRepo(virtualMcp)) return true;
  const cloneUrl = (virtualMcp?.metadata as { cloneUrl?: string | null } | null)
    ?.cloneUrl;
  return typeof cloneUrl === "string" && cloneUrl.length > 0;
}
