import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { checkGhAccess } from "./gh-cli";
import { findContextRepo } from "./helpers";

export const CONTEXT_REPO_STATUS = defineTool({
  name: "CONTEXT_REPO_STATUS",
  description:
    "Get context repo status: GitHub CLI auth status and current context repo configuration.",
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

    const contextRepo = existing
      ? {
          connectionId: existing.connectionId,
          owner: existing.owner,
          repo: existing.repo,
          branch: existing.branch,
          lastSyncedCommit: existing.lastSyncedCommit,
          fileCount: existing.fileCount,
          indexSizeBytes: existing.indexSizeBytes,
          lastSyncedAt: existing.lastSyncedAt,
        }
      : null;

    return {
      gh: {
        available: ghStatus.available,
        user: ghStatus.user,
      },
      contextRepo,
    };
  },
});
