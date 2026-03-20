import { z } from "zod";
import { rm } from "node:fs/promises";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { getRepoPath } from "./gh-cli";
import { findContextRepo } from "./helpers";

export const CONTEXT_REPO_DISCONNECT = defineTool({
  name: "CONTEXT_REPO_DISCONNECT",
  description:
    "Disconnect the context repo: deletes the connection and cleans up the local clone and index.",
  annotations: {
    title: "Disconnect Context Repo",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    disconnected: z.boolean(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const existing = await findContextRepo(ctx);
    if (!existing) {
      return { disconnected: false };
    }

    // Delete the connection
    await ctx.storage.connections.delete(existing.connectionId);

    // Clean up local clone + index
    const repoPath = getRepoPath(orgId, existing.owner, existing.repo);
    try {
      await rm(repoPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }

    return { disconnected: true };
  },
});
