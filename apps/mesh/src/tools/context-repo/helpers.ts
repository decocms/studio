/**
 * Shared helpers for context repo tools
 */

import type { MeshContext } from "@/core/mesh-context";
import { getRepoPath } from "./gh-cli";

export interface ContextRepoConfig {
  connectionId: string;
  owner: string;
  repo: string;
  branch: string;
  lastSyncedCommit: string | null;
  fileCount: number;
  indexSizeBytes: number;
  lastSyncedAt: string | null;
}

/**
 * Find the context repo connection for the current organization.
 * Returns null if no context repo is configured.
 */
export async function findContextRepo(
  ctx: MeshContext,
): Promise<ContextRepoConfig | null> {
  const orgId = ctx.organization?.id;
  if (!orgId) return null;

  const connections = await ctx.storage.connections.list(orgId, {
    includeVirtual: true,
  });

  for (const conn of connections) {
    if (conn.connection_type !== "GITHUB") continue;

    let metadata: Record<string, unknown> | null = null;
    try {
      metadata =
        typeof conn.metadata === "string"
          ? JSON.parse(conn.metadata)
          : (conn.metadata as Record<string, unknown>);
    } catch {
      continue;
    }

    if (metadata?.type !== "context-repo") continue;

    return {
      connectionId: conn.id,
      owner: metadata.owner as string,
      repo: metadata.repo as string,
      branch: (metadata.branch as string) || "main",
      lastSyncedCommit: (metadata.lastSyncedCommit as string) || null,
      fileCount: (metadata.fileCount as number) || 0,
      indexSizeBytes: (metadata.indexSizeBytes as number) || 0,
      lastSyncedAt: (metadata.lastSyncedAt as string) || null,
    };
  }

  return null;
}

/**
 * Get the local disk path for the context repo
 */
export function getContextRepoPath(
  orgId: string,
  owner: string,
  repo: string,
): string {
  return getRepoPath(orgId, owner, repo);
}
