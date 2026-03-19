import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { cloneOrPull } from "./gh-cli";
import { buildIndex, saveIndex } from "./indexer";
import { findContextRepo, getContextRepoPath } from "./helpers";

export const CONTEXT_REPO_SYNC = defineTool({
  name: "CONTEXT_REPO_SYNC",
  description: "Pull latest changes from the context repo and reindex.",
  annotations: {
    title: "Sync Context Repo",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    headCommit: z.string(),
    fileCount: z.number(),
    indexSizeBytes: z.number(),
  }),
  handler: async (_, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config)
      throw new Error(
        "No context repo configured. Use CONTEXT_REPO_SETUP first.",
      );

    const { headCommit } = await cloneOrPull(
      orgId,
      config.owner,
      config.repo,
      config.branch,
    );

    const repoPath = getContextRepoPath(orgId, config.owner, config.repo);
    const index = await buildIndex(repoPath);
    await saveIndex(repoPath, index);

    await ctx.storage.connections.update(config.connectionId, {
      metadata: {
        type: "context-repo",
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        lastSyncedCommit: headCommit,
        fileCount: index.fileCount,
        indexSizeBytes: index.totalSizeBytes,
        lastSyncedAt: new Date().toISOString(),
      },
    });

    return {
      owner: config.owner,
      repo: config.repo,
      headCommit,
      fileCount: index.fileCount,
      indexSizeBytes: index.totalSizeBytes,
    };
  },
});
