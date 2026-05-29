import type { GithubRepo, VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { GITHUB_APP_ID } from "@/web/utils/constants";

/**
 * Returns the GitHub repo metadata if it's usable to boot a VM:
 *  - No `connectionId`: public-clone mode (unauthenticated git clone). Always active.
 *  - With `connectionId`: only active when GitHub is still attached to the
 *    Virtual MCP (otherwise the metadata is stale and would fail at token
 *    lookup). GitHub is attached either as a concrete child connection (legacy
 *    agents) or as a typed slot for the GitHub app_id (current agents, since
 *    the GitHub connection is user-private).
 */
export function getActiveGithubRepo(
  virtualMcp: VirtualMCPEntity | null | undefined,
): GithubRepo | null {
  const repo = virtualMcp?.metadata?.githubRepo;
  if (!repo) return null;
  if (!repo.connectionId) return repo;

  const hasConnection =
    virtualMcp?.connections?.some(
      (c) => c.connection_id === repo.connectionId,
    ) || virtualMcp?.slots?.some((s) => s.slot_app_id === GITHUB_APP_ID);

  return hasConnection ? repo : null;
}
