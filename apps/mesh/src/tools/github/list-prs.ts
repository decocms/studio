import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { githubGet } from "@/git-providers/adapters/github/octokit-factory";

interface PullSummary {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export const GITHUB_LIST_PRS = defineTool({
  name: "GITHUB_LIST_PRS",
  description:
    "List pull requests in a GitHub repo. Supports filtering by state (open/closed/all) and head branch.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    head: z
      .string()
      .optional()
      .describe("Filter by head branch, e.g. 'username:feature-branch'"),
    perPage: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: z.object({
    pulls: z.array(
      z.object({
        number: z.number(),
        url: z.string(),
        state: z.string(),
        draft: z.boolean(),
        title: z.string(),
        author: z.string(),
        headRef: z.string(),
        headSha: z.string(),
        baseRef: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        mergedAt: z.string().nullable(),
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

    const data = await githubGet<PullSummary[]>(
      client.token,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
      {
        state: input.state,
        head: input.head,
        per_page: input.perPage,
      },
    );

    return {
      pulls: data.map((p) => ({
        number: p.number,
        url: p.html_url,
        state: p.state,
        draft: p.draft,
        title: p.title,
        author: p.user.login,
        headRef: p.head.ref,
        headSha: p.head.sha,
        baseRef: p.base.ref,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        mergedAt: p.merged_at,
      })),
      actor: client.actor,
    };
  },
});
