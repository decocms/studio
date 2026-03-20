import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { findContextRepo, getContextRepoPath } from "./helpers";

export const CONTEXT_REPO_READ = defineTool({
  name: "CONTEXT_REPO_READ",
  description: "Read a specific file from the context repo.",
  annotations: {
    title: "Read Context Repo File",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    path: z.string().min(1).describe("Relative file path within the repo"),
  }),
  outputSchema: z.object({
    path: z.string(),
    content: z.string(),
    size: z.number(),
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

    // Path traversal protection
    const fullPath = resolve(join(repoPath, input.path));
    const resolvedRoot = resolve(repoPath);
    if (!fullPath.startsWith(resolvedRoot + "/") && fullPath !== resolvedRoot) {
      throw new Error("Invalid path: must be within the repository");
    }

    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new Error(`File not found: ${input.path}`);
    }

    if (fileStat.size > 500 * 1024) {
      throw new Error(
        `File too large (${Math.round(fileStat.size / 1024)}KB). Max 500KB.`,
      );
    }

    const content = await readFile(fullPath, "utf-8");

    return { path: input.path, content, size: fileStat.size };
  },
});
