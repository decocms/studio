import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { githubGraphql } from "./graphql";

/**
 * The most recent merged pull request into a base branch — in Fast Preview
 * every publish is a squash-merged PR, so this IS the last publish.
 *
 * `states: MERGED` is why this is exact. REST can only filter `state: closed`,
 * which interleaves PRs closed WITHOUT merging, so it takes a page of PRs to
 * answer and still reports "never published" for a base whose whole page was
 * abandoned.
 */
const LAST_PUBLISHED_QUERY = `
query LastPublishedPr($owner: String!, $repo: String!, $base: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      states: MERGED
      baseRefName: $base
      first: 1
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        body
        mergedAt
        url
        baseRefName
        headRefName
        headRefOid
        author { login }
      }
    }
  }
}`;

const lastPublishedOutput = z.object({
  /** null when nothing has ever been merged into this base. */
  pullRequest: z
    .object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      mergedAt: z.string().nullable(),
      base: z.string(),
      head: z.string(),
      headSha: z.string(),
      htmlUrl: z.string(),
      author: z.string(),
    })
    .nullable(),
});

export type LastPublishedPrResult = z.infer<typeof lastPublishedOutput>;

export interface LastPublishedPrResponse {
  repository?: {
    pullRequests?: {
      nodes?: Array<{
        number?: number | null;
        title?: string | null;
        body?: string | null;
        mergedAt?: string | null;
        url?: string | null;
        baseRefName?: string | null;
        headRefName?: string | null;
        headRefOid?: string | null;
        author?: { login?: string | null } | null;
      } | null> | null;
    } | null;
  } | null;
}

/** Throws rather than reporting "never published" when the repo was hidden. */
export function parseLastPublishedPr(
  payload: LastPublishedPrResponse,
): LastPublishedPrResult {
  const repository = payload.repository;
  if (!repository) {
    throw new Error(
      "Repository not found or not accessible by this connection",
    );
  }
  const pr = repository.pullRequests?.nodes?.[0];
  if (!pr) return { pullRequest: null };

  return {
    pullRequest: {
      number: pr.number ?? 0,
      title: pr.title ?? "",
      body: pr.body ?? "",
      mergedAt: pr.mergedAt ?? null,
      base: pr.baseRefName ?? "main",
      head: pr.headRefName ?? "",
      headSha: pr.headRefOid ?? "",
      htmlUrl: pr.url ?? "",
      author: pr.author?.login ?? "",
    },
  };
}

export const GITHUB_LAST_PUBLISHED_PR = defineTool({
  name: "GITHUB_LAST_PUBLISHED_PR",
  description:
    "Read the most recently merged pull request into a base branch — in Fast Preview, the last publish.",
  annotations: {
    title: "Read Last Published Pull Request",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    connectionId: z.string().describe("ID of the mcp-github connection to use"),
    owner: z.string().describe("Repository owner (user or org login)"),
    repo: z.string().describe("Repository name"),
    base: z.string().describe("Base branch publishes merge into"),
  }),
  outputSchema: lastPublishedOutput,
  handler: async (input, ctx) => {
    await ctx.access.check();

    const data = await githubGraphql<LastPublishedPrResponse>(ctx, {
      connectionId: input.connectionId,
      query: LAST_PUBLISHED_QUERY,
      variables: { owner: input.owner, repo: input.repo, base: input.base },
      label: `last published pull request for ${input.owner}/${input.repo}@${input.base}`,
      operation: "last_published_pr",
    });

    return parseLastPublishedPr(data);
  },
});
