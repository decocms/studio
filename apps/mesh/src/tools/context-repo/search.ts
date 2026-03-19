import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { loadIndex, searchIndex } from "./indexer";
import { findContextRepo, getContextRepoPath } from "./helpers";

export const CONTEXT_REPO_SEARCH = defineTool({
  name: "CONTEXT_REPO_SEARCH",
  description:
    "Search across all indexed files in the context repo. Returns matching file paths with relevant snippets.",
  annotations: {
    title: "Search Context Repo",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    query: z.string().min(1).describe("Search query (space-separated terms)"),
    limit: z.number().min(1).max(50).default(20).describe("Max results"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        path: z.string(),
        snippet: z.string(),
        rank: z.number(),
      }),
    ),
    totalIndexed: z.number(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config)
      throw new Error(
        "No context repo configured. Use CONTEXT_REPO_SETUP first.",
      );

    const repoPath = getContextRepoPath(orgId, config.owner, config.repo);
    const index = await loadIndex(repoPath);
    if (!index)
      throw new Error("Index not found. Run CONTEXT_REPO_SYNC to rebuild.");

    const results = searchIndex(index, input.query, input.limit);

    return { results, totalIndexed: index.fileCount };
  },
});
