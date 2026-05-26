import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { githubPost } from "@/git-providers/adapters/github/octokit-factory";
import { withBotFooter } from "./_shared/bot-footer";

interface CommentResponse {
  id: number;
  html_url: string;
  user: { login: string };
}

/**
 * GitHub treats PRs as issues for comment purposes — `/issues/{n}/comments`
 * works for both. This single tool covers issue + PR comments rather than
 * splitting into two near-identical tools.
 */
export const GITHUB_COMMENT = defineTool({
  name: "GITHUB_COMMENT",
  description:
    "Add a comment to a GitHub issue or pull request. Acts as the calling user when present, else as Decobot (with a footer linking to the Studio request).",
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive().describe("Issue or PR number"),
    body: z.string().min(1),
  }),
  outputSchema: z.object({
    id: z.number(),
    url: z.string(),
    author: z.string(),
    actor: z.enum(["user", "bot"]),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const client = await ctx.gitProviders.resolveClient(ctx, {
      owner: input.owner,
    });

    const data = await githubPost<CommentResponse>(
      client.token,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}/comments`,
      { body: withBotFooter(input.body, client, ctx) },
    );

    return {
      id: data.id,
      url: data.html_url,
      author: data.user.login,
      actor: client.actor,
    };
  },
});
