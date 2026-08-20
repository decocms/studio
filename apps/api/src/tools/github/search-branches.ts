import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  githubConnectionAccessToken,
  isGithubConnection,
} from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
/** Matches the Git Data client's per-attempt timeout in `decofile/github-git-data.ts`. */
const GITHUB_TIMEOUT_MS = 15_000;

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

/**
 * A 2xx response body isn't guaranteed to be JSON (a proxy/outage page can
 * still answer 200), and `res.json()` throwing a raw `SyntaxError` on that
 * would surface as an opaque "Unexpected token" instead of naming what
 * failed. Same gap the Jira client closed for its own 2xx-but-malformed
 * case (#6308).
 */
export async function parseJsonBody(
  res: Response,
  repoLabel: string,
): Promise<BranchSearchResponse> {
  const text = await res.text();
  try {
    return JSON.parse(text) as BranchSearchResponse;
  } catch (cause) {
    throw new Error(
      `GitHub GraphQL branch search for ${repoLabel} returned invalid JSON: ${text.slice(0, 300)}`,
      { cause },
    );
  }
}

/**
 * A secondary-rate-limit or abuse-detection response (403/429 + `Retry-After`)
 * looks identical to a real permissions/server failure once reduced to a bare
 * status code, so callers can't tell "wait and retry" from "this is broken".
 */
export function branchSearchErrorMessage(
  status: number,
  retryAfterHeader: string | null,
): string {
  if ((status === 403 || status === 429) && retryAfterHeader) {
    return `GitHub GraphQL branch search rate-limited, retry after ${retryAfterHeader}s`;
  }
  return `GitHub GraphQL branch search failed: ${status}`;
}

interface BranchSearchResponse {
  data?: {
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
  };
  errors?: Array<{ message?: string }>;
}

/**
 * Narrow the GraphQL payload to the tool's output.
 *
 * Every level is optional in the schema: a commit authored by an address with
 * no GitHub account has `author.user === null`, as does a ref whose target the
 * union does not resolve to a Commit. Throws rather than returning a plausible
 * empty result when GitHub reported an error or hid the repository, so "no
 * matches" never masks "not allowed to look".
 */
export function parseBranchSearchResponse(
  payload: BranchSearchResponse,
  repoLabel: string,
): BranchSearchResult {
  const error = payload.errors?.[0]?.message;
  if (error) {
    throw new Error(`GitHub GraphQL branch search failed: ${error}`);
  }
  const repository = payload.data?.repository;
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

    // Ownership guard (as in GITHUB_LIST_USER_ORGS): no cross-org token reads.
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }
    const connection = await ctx.storage.connections.findById(
      input.connectionId,
      organizationId,
    );
    if (!connection) {
      throw new Error("Connection not found");
    }
    if (!isGithubConnection(connection)) {
      throw new Error("Connection is not a GitHub connection");
    }

    const accessToken = await githubConnectionAccessToken(ctx, connection);
    if (!accessToken) {
      throw new Error(RECONNECT_ERROR);
    }

    const search = input.query.trim();
    const post = (token: string) =>
      fetch(GITHUB_GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: BRANCH_SEARCH_QUERY,
          variables: {
            owner: input.owner,
            repo: input.repo,
            // null is GraphQL's "no filter".
            query: search === "" ? null : search,
            limit: input.limit,
          },
        }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });

    let res = await post(accessToken);

    // Token revoked/rotated behind our clock: one refresh + retry, then give up.
    if (res.status === 401) {
      // Drain the discarded 401 body so its connection is released.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const refreshed = await githubConnectionAccessToken(ctx, connection, {
        forceRefresh: true,
      });
      if (!refreshed) {
        throw new Error(RECONNECT_ERROR);
      }
      res = await post(refreshed);
      if (res.status === 401) {
        throw new Error(RECONNECT_ERROR);
      }
    }

    if (!res.ok) {
      throw new Error(
        branchSearchErrorMessage(res.status, res.headers.get("retry-after")),
      );
    }

    // GraphQL reports failures as 200 + `errors`, so an ok status isn't enough.
    const repoLabel = `${input.owner}/${input.repo}`;
    return parseBranchSearchResponse(
      await parseJsonBody(res, repoLabel),
      repoLabel,
    );
  },
});
