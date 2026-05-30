import type { GithubRepo, VirtualMCPEntity } from "@decocms/mesh-sdk/types";

/**
 * Returns the GitHub repo metadata if it's usable to boot a VM:
 *  - No `connectionId`: public-clone mode (unauthenticated git clone). Always active.
 *  - With `connectionId`: only active when the connection is still attached
 *    to the Virtual MCP (otherwise the metadata is stale and would fail at
 *    token lookup).
 */
export function getActiveGithubRepo(
  virtualMcp: VirtualMCPEntity | null | undefined,
): GithubRepo | null {
  const repo = virtualMcp?.metadata?.githubRepo;
  if (!repo) return null;
  if (!repo.connectionId) return repo;

  const hasConnection = virtualMcp?.connections?.some(
    (c) => c.connection_id === repo.connectionId,
  );

  return hasConnection ? repo : null;
}
