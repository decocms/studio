import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { githubGet } from "@/git-providers/adapters/github/octokit-factory";

interface ContentResponse {
  type: "file";
  encoding: "base64";
  content: string;
  size: number;
  name: string;
  path: string;
  sha: string;
}

export const GITHUB_READ_FILE = defineTool({
  name: "GITHUB_READ_FILE",
  description:
    "Read a file from a GitHub repo at a given ref (default branch when omitted). Acts as the calling user when present, else as Decobot.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string().describe("Repo owner (org or user login)."),
    repo: z.string(),
    path: z.string(),
    ref: z.string().optional().describe("Branch, tag, or commit SHA."),
  }),
  outputSchema: z.object({
    path: z.string(),
    sha: z.string(),
    size: z.number(),
    content: z.string().describe("UTF-8 decoded file contents."),
    actor: z.enum(["user", "bot"]),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const client = await ctx.gitProviders.resolveClient(ctx, {
      owner: input.owner,
    });

    const data = await githubGet<ContentResponse>(
      client.token,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      { ref: input.ref },
    );

    if (data.type !== "file") {
      throw new Error(
        `Path "${input.path}" is not a file (got ${data.type}). Use GITHUB_LIST_REPO_CONTENTS for directories.`,
      );
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return {
      path: data.path,
      sha: data.sha,
      size: data.size,
      content,
      actor: client.actor,
    };
  },
});
