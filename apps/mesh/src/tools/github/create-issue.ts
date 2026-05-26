import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { githubPost } from "@/git-providers/adapters/github/octokit-factory";
import { withBotFooter } from "./_shared/bot-footer";

interface CreateIssueResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  title: string;
  user: { login: string };
}

export const GITHUB_CREATE_ISSUE = defineTool({
  name: "GITHUB_CREATE_ISSUE",
  description:
    "Create a GitHub issue. When a real user invokes this, the issue is opened by that user. For unattended runs (cron, event-bus), it's opened by Decobot with a 'via Decobot' footer linking back to the Studio request.",
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string().min(1),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    number: z.number(),
    url: z.string(),
    state: z.string(),
    title: z.string(),
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

    const data = await githubPost<CreateIssueResponse>(
      client.token,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`,
      {
        title: input.title,
        body: withBotFooter(input.body, client, ctx),
        labels: input.labels,
        assignees: input.assignees,
      },
    );

    return {
      number: data.number,
      url: data.html_url,
      state: data.state,
      title: data.title,
      author: data.user.login,
      actor: client.actor,
    };
  },
});
