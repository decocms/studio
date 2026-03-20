import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo, getContextRepoPath } from "./helpers";
import { buildIndex, saveIndex } from "./indexer";

export const CONTEXT_REPO_UPDATE_FOLDERS = defineTool({
  name: "CONTEXT_REPO_UPDATE_FOLDERS",
  description:
    "Update which folders are indexed in the context repo. Reindexes with the new folder selection.",
  annotations: {
    title: "Update Indexed Folders",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    folders: z
      .array(z.string())
      .describe(
        "Folders to index. Empty array means index all folders (no filter).",
      ),
  }),
  outputSchema: z.object({
    fileCount: z.number(),
    indexSizeBytes: z.number(),
    indexedFolders: z.array(z.string()),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const existing = await findContextRepo(ctx);
    if (!existing) throw new Error("No context repo configured");

    const repoPath = getContextRepoPath(orgId, existing.owner, existing.repo);
    const folderFilter = input.folders.length > 0 ? input.folders : null;

    const index = await buildIndex(repoPath, folderFilter);
    await saveIndex(repoPath, index);

    // Update connection metadata
    const connections = await ctx.storage.connections.list(orgId, {
      includeVirtual: true,
    });
    const conn = connections.find((c) => c.id === existing.connectionId);
    if (conn) {
      const metadata =
        typeof conn.metadata === "string"
          ? JSON.parse(conn.metadata)
          : (conn.metadata ?? {});

      await ctx.storage.connections.update(existing.connectionId, {
        metadata: {
          ...metadata,
          indexedFolders: folderFilter,
          fileCount: index.fileCount,
          indexSizeBytes: index.totalSizeBytes,
          lastSyncedAt: new Date().toISOString(),
        },
      });
    }

    return {
      fileCount: index.fileCount,
      indexSizeBytes: index.totalSizeBytes,
      indexedFolders: input.folders,
    };
  },
});
