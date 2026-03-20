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
  indexedFolders: string[] | null;
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
      indexedFolders: (metadata.indexedFolders as string[]) || null,
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

export interface FolderInfo {
  name: string; // "<root>" for root-level files, or folder name
  fileCount: number;
  totalBytes: number;
}

/**
 * List top-level directories in a cloned repo with file counts and sizes.
 * Includes a "<root>" entry for files directly in the repo root.
 * Excludes .git and hidden dirs.
 */
export async function listRepoFolders(repoPath: string): Promise<FolderInfo[]> {
  const { listAllFiles } = await import("./gh-cli");
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");

  try {
    const allFiles = await listAllFiles(repoPath);
    const folderMap = new Map<string, { count: number; bytes: number }>();

    for (const filePath of allFiles) {
      const parts = filePath.split("/");
      const folderName = parts.length === 1 ? "<root>" : parts[0]!;

      // Skip hidden dirs and .git
      if (folderName.startsWith(".") && folderName !== "<root>") continue;

      if (!folderMap.has(folderName)) {
        folderMap.set(folderName, { count: 0, bytes: 0 });
      }
      const entry = folderMap.get(folderName)!;
      entry.count++;

      try {
        const fileStat = await stat(join(repoPath, filePath));
        entry.bytes += fileStat.size;
      } catch {
        // Skip files we can't stat
      }
    }

    const results: FolderInfo[] = [];

    // Root files first
    const rootEntry = folderMap.get("<root>");
    if (rootEntry) {
      results.push({
        name: "<root>",
        fileCount: rootEntry.count,
        totalBytes: rootEntry.bytes,
      });
      folderMap.delete("<root>");
    }

    // Then folders sorted alphabetically
    const sortedFolders = [...folderMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [name, info] of sortedFolders) {
      results.push({
        name,
        fileCount: info.count,
        totalBytes: info.bytes,
      });
    }

    return results;
  } catch {
    return [];
  }
}
