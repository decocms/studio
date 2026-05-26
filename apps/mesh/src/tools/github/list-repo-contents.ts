import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { githubGet } from "@/git-providers/adapters/github/octokit-factory";

interface DirEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
  size: number;
}

export const GITHUB_LIST_REPO_CONTENTS = defineTool({
  name: "GITHUB_LIST_REPO_CONTENTS",
  description:
    "List entries in a directory of a GitHub repo. Returns names, types (file/dir), and sizes. For a single file, use GITHUB_READ_FILE.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    path: z.string().default("").describe("Directory path (empty = root)."),
    ref: z.string().optional().describe("Branch, tag, or commit SHA."),
  }),
  outputSchema: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        type: z.string(),
        name: z.string(),
        path: z.string(),
        sha: z.string(),
        size: z.number(),
      }),
    ),
    actor: z.enum(["user", "bot"]),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const client = await ctx.gitProviders.resolveClient(ctx, {
      owner: input.owner,
    });

    const safePath = input.path
      ? input.path.split("/").filter(Boolean).map(encodeURIComponent).join("/")
      : "";
    const data = await githubGet<DirEntry[] | DirEntry>(
      client.token,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${safePath}`,
      { ref: input.ref },
    );

    if (!Array.isArray(data)) {
      throw new Error(
        `Path "${input.path}" is not a directory. Use GITHUB_READ_FILE.`,
      );
    }

    return {
      path: input.path,
      entries: data.map((e) => ({
        type: e.type,
        name: e.name,
        path: e.path,
        sha: e.sha,
        size: e.size,
      })),
      actor: client.actor,
    };
  },
});
