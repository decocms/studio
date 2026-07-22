import type { GithubRepo } from "@decocms/mesh-sdk";

/**
 * Pure decision logic for mirroring a GitHub repo onto the Report Agent's
 * `metadata.githubRepo` + connection aggregations. The I/O (MCP calls,
 * provisioning, rollback) lives in the mutation; this module owns the branches
 * that decide *what* to write, so they can be unit-tested without a live agent.
 */

/** Split `owner/name` into its parts. `null` when the shape is invalid. */
export function parseRepoFullName(
  githubRepo: string,
): { owner: string; name: string } | null {
  const [owner, name] = githubRepo.split("/");
  if (!owner || !name) {
    return null;
  }
  return { owner, name };
}

/**
 * Decide whether the repo-scoped connection already on the agent can be reused.
 * Reuse only when a connectionId is present AND the same repo is being re-saved
 * — GitHub owner/name are case-insensitive, so compare lowercased. Returns the
 * reusable connection's id + installationId, or `null` to provision a fresh one.
 */
export function planRepoReuse(params: {
  existingRepo?: GithubRepo | null;
  owner: string;
  name: string;
}): { connectionId: string; installationId?: number } | null {
  const { existingRepo, owner, name } = params;
  if (
    existingRepo?.connectionId &&
    existingRepo.owner.toLowerCase() === owner.toLowerCase() &&
    existingRepo.name.toLowerCase() === name.toLowerCase()
  ) {
    return {
      connectionId: existingRepo.connectionId,
      installationId: existingRepo.installationId,
    };
  }
  return null;
}

/**
 * Compute the agent's new connection list and any connection that became stale.
 *
 * - `staleConnectionId`: a connection from a previously-linked repo that the
 *   metadata write is about to orphan (delete it AFTER the write, since
 *   `child_connection_id` is ON DELETE RESTRICT — migration 026).
 * - `mergedConnections`: existing connections minus the repo/stale ones, plus
 *   the repo-scoped connection as a credential-only link (`selected_tools: []`
 *   keeps GitHub tools off the report agent). Existing entries are preserved
 *   as-is so their `selected_tools`/`selected_resources`/`selected_prompts`
 *   survive the round-trip.
 */
export function planAgentConnections<
  T extends { connection_id: string },
>(params: {
  existingRepo?: GithubRepo | null;
  existingConnections: T[];
  repoConnectionId: string;
}): {
  staleConnectionId?: string;
  mergedConnections: Array<T | { connection_id: string; selected_tools: [] }>;
} {
  const { existingRepo, existingConnections, repoConnectionId } = params;

  const staleConnectionId =
    existingRepo?.connectionId && existingRepo.connectionId !== repoConnectionId
      ? existingRepo.connectionId
      : undefined;

  const mergedConnections = [
    ...existingConnections.filter(
      (c) =>
        c.connection_id !== repoConnectionId &&
        c.connection_id !== staleConnectionId,
    ),
    { connection_id: repoConnectionId, selected_tools: [] as [] },
  ];

  return { staleConnectionId, mergedConnections };
}
