import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { checkGhAccess, cloneOrPull, getRepoPath } from "./gh-cli";
import { findContextRepo, listRepoFolders } from "./helpers";

export const CONTEXT_REPO_SETUP = defineTool({
  name: "CONTEXT_REPO_SETUP",
  description:
    "Clone a GitHub repository as the context repo for this organization. Does NOT index — call CONTEXT_REPO_UPDATE_FOLDERS after to select folders and index.",
  annotations: {
    title: "Setup Context Repo",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .describe("GitHub owner (user or org)"),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .describe("GitHub repository name"),
    branch: z.string().default("main").describe("Branch to track"),
  }),
  outputSchema: z.object({
    connectionId: z.string(),
    owner: z.string(),
    repo: z.string(),
    branch: z.string(),
    headCommit: z.string(),
    folders: z.array(
      z.object({
        name: z.string(),
        fileCount: z.number(),
        totalBytes: z.number(),
      }),
    ),
    ghUser: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const ghStatus = await checkGhAccess();
    if (!ghStatus.available) {
      throw new Error(
        "GitHub CLI (gh) is not installed or not authenticated. Run: brew install gh && gh auth login",
      );
    }

    const existing = await findContextRepo(ctx);
    if (existing) {
      throw new Error(
        `Context repo already configured: ${existing.owner}/${existing.repo}. Disconnect first.`,
      );
    }

    // Clone only — no indexing yet
    const { headCommit } = await cloneOrPull(
      orgId,
      input.owner,
      input.repo,
      input.branch,
    );

    const repoPath = getRepoPath(orgId, input.owner, input.repo);
    const folders = await listRepoFolders(repoPath);

    // Create connection with zero index stats (will be updated by UPDATE_FOLDERS)
    const connection = await ctx.storage.connections.create({
      organization_id: orgId,
      title: `Context: ${input.owner}/${input.repo}`,
      description: "GitHub context repository for this organization",
      connection_type: "GITHUB",
      connection_url: `https://github.com/${input.owner}/${input.repo}`,
      metadata: {
        type: "context-repo",
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        lastSyncedCommit: headCommit,
        fileCount: 0,
        indexSizeBytes: 0,
        indexedFolders: null,
        lastSyncedAt: null,
      },
      status: "active",
      created_by: ctx.auth.user?.id || "system",
    });

    return {
      connectionId: connection.id,
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      headCommit,
      folders,
      ghUser: ghStatus.user,
    };
  },
});
