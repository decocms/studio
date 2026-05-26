import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  githubGet,
  githubGetText,
} from "@/git-providers/adapters/github/octokit-factory";

interface PullDetail {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string | null;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable: boolean | null;
}

export const GITHUB_READ_PR = defineTool({
  name: "GITHUB_READ_PR",
  description:
    "Read a pull request's metadata and optionally its unified diff. The diff is fetched separately via the GitHub diff media type.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    includeDiff: z
      .boolean()
      .default(false)
      .describe("When true, also returns the unified diff (can be large)."),
  }),
  outputSchema: z.object({
    number: z.number(),
    url: z.string(),
    state: z.string(),
    draft: z.boolean(),
    title: z.string(),
    body: z.string().nullable(),
    author: z.string(),
    headRef: z.string(),
    headSha: z.string(),
    baseRef: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    mergedAt: z.string().nullable(),
    additions: z.number(),
    deletions: z.number(),
    changedFiles: z.number(),
    mergeable: z.boolean().nullable(),
    diff: z.string().optional(),
    actor: z.enum(["user", "bot"]),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const client = await ctx.gitProviders.resolveClient(ctx, {
      owner: input.owner,
    });

    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`;
    const data = await githubGet<PullDetail>(client.token, path);

    const diff = input.includeDiff
      ? await githubGetText(
          client.token,
          path,
          "application/vnd.github.v3.diff",
        )
      : undefined;

    return {
      number: data.number,
      url: data.html_url,
      state: data.state,
      draft: data.draft,
      title: data.title,
      body: data.body,
      author: data.user.login,
      headRef: data.head.ref,
      headSha: data.head.sha,
      baseRef: data.base.ref,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      mergedAt: data.merged_at,
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
      mergeable: data.mergeable,
      ...(diff !== undefined ? { diff } : {}),
      actor: client.actor,
    };
  },
});
