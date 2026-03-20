import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { checkGhAccess, getRepoPath } from "./gh-cli";
import { findContextRepo, listRepoFolders } from "./helpers";

export const CONTEXT_REPO_STATUS = defineTool({
  name: "CONTEXT_REPO_STATUS",
  description:
    "Get context repo status: GitHub CLI auth status, current config, and available folders.",
  annotations: {
    title: "Context Repo Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    gh: z.object({
      available: z.boolean(),
      user: z.string().optional(),
    }),
    contextRepo: z
      .object({
        connectionId: z.string(),
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        lastSyncedCommit: z.string().nullable(),
        fileCount: z.number(),
        indexSizeBytes: z.number(),
        lastSyncedAt: z.string().nullable(),
        indexedFolders: z.array(z.string()).nullable(),
        folders: z.array(
          z.object({
            name: z.string(),
            fileCount: z.number(),
            totalBytes: z.number(),
          }),
        ),
      })
      .nullable(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const [ghStatus, existing] = await Promise.all([
      checkGhAccess(),
      findContextRepo(ctx),
    ]);

    let contextRepo = null;
    if (existing) {
      const orgId = ctx.organization!.id;
      const repoPath = getRepoPath(orgId, existing.owner, existing.repo);
      const folders = await listRepoFolders(repoPath);

      contextRepo = {
        connectionId: existing.connectionId,
        owner: existing.owner,
        repo: existing.repo,
        branch: existing.branch,
        lastSyncedCommit: existing.lastSyncedCommit,
        fileCount: existing.fileCount,
        indexSizeBytes: existing.indexSizeBytes,
        lastSyncedAt: existing.lastSyncedAt,
        indexedFolders: existing.indexedFolders,
        folders,
      };
    }

    return {
      gh: {
        available: ghStatus.available,
        user: ghStatus.user,
      },
      contextRepo,
    };
  },
});
