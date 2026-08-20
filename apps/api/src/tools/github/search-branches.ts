import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { githubGraphql } from "./graphql";

/**
 * Server-side branch search.
 *
 * REST `GET /repos/{owner}/{repo}/branches` (github-mcp-server's
 * `list_branches`) takes no search, filter or sort parameter, so a picker built
 * on it can only page 100-at-a-time and grep locally — on a repo with hundreds
 * of branches the one you typed shows up several "load more" clicks later.
 *
 * GraphQL `repository.refs(query:)` filters by a case-insensitive SUBSTRING of
 * the full ref name in one round trip ("upstream" finds
 * `claude/fastpreview-upstream-authority`), which is what github.com's own
 * branch dropdown uses. `totalCount` is the true match count, so the caller can
 * say how many matches it is not showing.
 *
 * Note `orderBy` is deliberately ALPHABETICAL: GitHub silently ignores
 * TAG_COMMIT_DATE for branch refs and returns alphabetical order anyway, so
 * asking for recency here would be a lie. Ranking by recency would need a
 * server-side answer — sorting this alphabetically-truncated window on the
 * client would look ranked while omitting the actually-newest branch.
 */
const BRANCH_SEARCH_QUERY = `
query BranchSearch($owner: String!, $repo: String!, $query: String, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    refs(
      refPrefix: "refs/heads/"
      query: $query
      first: $limit
      orderBy: { field: ALPHABETICAL, direction: ASC }
    ) {
      totalCount
      nodes {
        name
        target {
          ... on Commit {
            author { user { login } }
          }
        }
      }
    }
  }
}`;

const branchSearchOutput = z.object({
  branches: z.array(
    z.object({
      name: z.string(),
      author: z.string().nullable(),
    }),
  ),
  /** Total branches matching `query`, which may exceed `branches.length`. */
  totalCount: z.number(),
});

export type BranchSearchResult = z.infer<typeof branchSearchOutput>;

export interface BranchSearchData {
  repository?: {
    refs?: {
      totalCount?: number;
      nodes?: Array<{
        name?: string | null;
        target?: {
          author?: { user?: { login?: string | null } | null } | null;
        } | null;
      } | null> | null;
    } | null;
  } | null;
}

/**
 * Narrow the GraphQL payload to the tool's output. Every level is optional: a
 * commit authored by an address with no GitHub account has `author.user ===
 * null`, as does a ref whose target does not resolve to a Commit. A hidden
 * repository throws, so "no matches" never masks "not allowed to look".
 */
export function parseBranchSearchResponse(
  payload: BranchSearchData,
  repoLabel: string,
): BranchSearchResult {
  const repository = payload.repository;
  if (!repository) {
    throw new Error(
      `Repository ${repoLabel} not found or not accessible by this connection`,
    );
  }

  const branches = (repository.refs?.nodes ?? [])
    .filter(
      (node): node is NonNullable<typeof node> & { name: string } =>
        typeof node?.name === "string",
    )
    .map((node) => ({
      name: node.name,
      author: node.target?.author?.user?.login ?? null,
    }));

  return {
    branches,
    totalCount: repository.refs?.totalCount ?? branches.length,
  };
}

export const GITHUB_SEARCH_BRANCHES = defineTool({
  name: "GITHUB_SEARCH_BRANCHES",
  description:
    "Search a repository's branches by a case-insensitive substring of the branch name, filtered server-side by GitHub.",
  annotations: {
    title: "Search GitHub Branches",
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
    query: z
      .string()
      .describe(
        "Substring to match against branch names. Empty returns the first branches alphabetically.",
      ),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: branchSearchOutput,
  handler: async (input, ctx) => {
    await ctx.access.check();

    const repoLabel = `${input.owner}/${input.repo}`;
    const search = input.query.trim();
    const data = await githubGraphql<BranchSearchData>(ctx, {
      connectionId: input.connectionId,
      query: BRANCH_SEARCH_QUERY,
      variables: {
        owner: input.owner,
        repo: input.repo,
        // null is GraphQL's "no filter".
        query: search === "" ? null : search,
        limit: input.limit,
      },
      label: `branch search for ${repoLabel}`,
    });

    return parseBranchSearchResponse(data, repoLabel);
  },
});
