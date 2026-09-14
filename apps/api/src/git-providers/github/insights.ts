/**
 * `RepoInsightsClient` over GitHub — GraphQL for the two history walks, REST
 * for the tree, the file and the code search.
 *
 * The split follows the quota rather than taste. A year of pull requests with
 * their commits and line stats is one GraphQL query per page against the
 * points/hour budget; the same answer over REST is one call for the list plus
 * one per pull request for its commits, against the requests/hour budget every
 * other Studio caller is already spending. Trees, blobs and code search have no
 * GraphQL equivalent worth the points, so they stay on REST.
 *
 * The field selection is ported from the reports worker's own GitHub client, so
 * the analysis that reads these rows — bot detection, no-reply emails, batch
 * size, lead time — loses nothing in the move.
 */

import { type RepoRef, splitOwnerName } from "@decocms/shared/git-providers";
import { githubGraphqlRequest } from "./graphql";
import {
  githubApiBaseUrl,
  githubFailure,
  githubFetch,
  githubJson,
} from "./http";
import { GitProviderError, type TokenSource } from "../types";
import {
  cappedLimit,
  type ChangeRequestHistoryItem,
  type ChangeRequestHistoryPage,
  type CodeSearchResult,
  DEFAULT_FILE_BYTES,
  DEFAULT_TREE_ENTRIES,
  type ListChangeRequestsParams,
  type ListCommitsParams,
  type ListTreeParams,
  loginLooksLikeBot,
  MAX_CHANGE_REQUEST_PAGE,
  MAX_COMMIT_PAGE,
  MAX_FILE_BYTES,
  MAX_SEARCH_HITS,
  MAX_TREE_ENTRIES,
  type ReadFileParams,
  readCappedBody,
  type RepoCommit,
  type RepoCommitPage,
  type RepoFileContent,
  type RepoInsightsCapabilities,
  type RepoInsightsClient,
  type RepoTreeEntry,
  type RepoTreeListing,
  type SearchCodeParams,
} from "../insights";

/** GitHub's commit page inside a pull request — the cap GraphQL allows in one hop. */
const PR_COMMIT_PAGE = 100;

export interface GithubPullRequestNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  baseRefName: string;
  headRefName: string;
  additions?: number | null;
  deletions?: number | null;
  author: { login?: string | null; __typename?: string | null } | null;
  commits?: {
    totalCount?: number | null;
    nodes?: Array<{ commit?: { oid?: string; committedDate?: string } }> | null;
  } | null;
}

export interface GithubCommitNode {
  oid: string;
  committedDate: string;
  messageHeadline?: string | null;
  author: {
    name?: string | null;
    email?: string | null;
    user?: { login?: string | null } | null;
  } | null;
}

interface PullRequestsPayload {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GithubPullRequestNode[] | null;
    };
  } | null;
}

interface CommitsPayload {
  repository: {
    ref?: { target?: CommitHistoryTarget | null } | null;
    defaultBranchRef?: { target?: CommitHistoryTarget | null } | null;
  } | null;
}

interface CommitHistoryTarget {
  history?: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GithubCommitNode[] | null;
  } | null;
}

interface GithubRawTreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

/** The `states:` argument for a caller's filter — null means "do not filter". */
export function pullRequestStates(
  state: ListChangeRequestsParams["state"],
): string[] | null {
  switch (state) {
    case "merged":
      return ["MERGED"];
    case "open":
      return ["OPEN"];
    case "all":
      return null;
  }
}

/**
 * The history query, with the two expensive selections added only when asked
 * for. They are not free even on GitHub: `commits(first: 100)` multiplies the
 * query's point cost by the page size, and a caller that only wants merge dates
 * should not pay it.
 */
export function pullRequestsQuery(opts: {
  includeCommits: boolean;
  includeStats: boolean;
}): string {
  const stats = opts.includeStats
    ? "\n        additions\n        deletions"
    : "";
  const commits = opts.includeCommits
    ? `\n        commits(first: ${PR_COMMIT_PAGE}) {
          totalCount
          nodes { commit { oid committedDate } }
        }`
    : "";
  return `
query RepoChangeRequests($owner: String!, $name: String!, $limit: Int!, $after: String, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: $limit
      after: $after
      states: $states
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        state
        createdAt
        updatedAt
        mergedAt
        closedAt
        baseRefName
        headRefName
        author { login __typename }${stats}${commits}
      }
    }
  }
}`;
}

/**
 * The commit-history query. A named ref and the default branch are different
 * selections on `repository`, not a variable, so the query is built for one or
 * the other — which is cheaper than resolving the default branch over REST
 * first just to name it here.
 */
export function commitHistoryQuery(hasRef: boolean): string {
  const target = hasRef ? "ref(qualifiedName: $ref)" : "defaultBranchRef";
  const refVar = hasRef ? ", $ref: String!" : "";
  return `
query RepoCommits($owner: String!, $name: String!, $since: GitTimestamp!, $limit: Int!, $after: String${refVar}) {
  repository(owner: $owner, name: $name) {
    ${target} {
      target {
        ... on Commit {
          history(first: $limit, since: $since, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              committedDate
              messageHeadline
              author { name email user { login } }
            }
          }
        }
      }
    }
  }
}`;
}

/** GitHub's pull request node → the neutral history row. Pure. */
export function mapPullRequest(
  node: GithubPullRequestNode,
): ChangeRequestHistoryItem {
  const login = node.author?.login ?? "";
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state:
      node.state === "MERGED"
        ? "merged"
        : node.state === "OPEN"
          ? "open"
          : "closed",
    author: {
      login,
      isBot: node.author?.__typename === "Bot" || loginLooksLikeBot(login),
    },
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    base: node.baseRefName,
    head: node.headRefName,
    additions: node.additions ?? null,
    deletions: node.deletions ?? null,
    commits: node.commits
      ? {
          count: node.commits.totalCount ?? null,
          items: (node.commits.nodes ?? []).flatMap((entry) =>
            entry.commit?.oid && entry.commit.committedDate
              ? [{ sha: entry.commit.oid, date: entry.commit.committedDate }]
              : [],
          ),
        }
      : null,
  };
}

/** GitHub's commit node → the neutral commit. Pure. */
export function mapCommit(node: GithubCommitNode): RepoCommit {
  return {
    sha: node.oid,
    date: node.committedDate,
    message: node.messageHeadline ?? "",
    author: {
      name: node.author?.name ?? null,
      email: node.author?.email ?? null,
      login: node.author?.user?.login ?? null,
    },
  };
}

/**
 * Drop rows the caller's window excludes, and report whether the page was cut
 * short by it. Ordering is UPDATED_AT descending, so the first row outside the
 * window means every later page is outside it too — which is what ends the walk
 * without asking GitHub for a filter it does not offer on this connection.
 */
export function withinUpdatedWindow(
  items: ChangeRequestHistoryItem[],
  updatedAfter: string | undefined,
): { items: ChangeRequestHistoryItem[]; reachedWindowEnd: boolean } {
  if (!updatedAfter) return { items, reachedWindowEnd: false };
  const floor = Date.parse(updatedAfter);
  if (!Number.isFinite(floor)) return { items, reachedWindowEnd: false };
  const kept: ChangeRequestHistoryItem[] = [];
  for (const item of items) {
    if (Date.parse(item.updatedAt) < floor) {
      return { items: kept, reachedWindowEnd: true };
    }
    kept.push(item);
  }
  return { items: kept, reachedWindowEnd: false };
}

/** GitHub's recursive tree → neutral entries, capped. Pure. */
export function mapTreeEntries(
  raw: { tree?: GithubRawTreeEntry[] | null; truncated?: boolean },
  maxEntries: number,
): { entries: RepoTreeEntry[]; truncated: boolean } {
  const entries: RepoTreeEntry[] = [];
  const rows = raw.tree ?? [];
  for (const row of rows) {
    if (entries.length >= maxEntries) {
      return { entries, truncated: true };
    }
    if (!row.path) continue;
    if (row.type !== "blob" && row.type !== "tree") continue;
    entries.push({
      path: row.path,
      type: row.type,
      ...(typeof row.size === "number" ? { size: row.size } : {}),
    });
  }
  return { entries, truncated: raw.truncated === true };
}

interface GithubSearchPayload {
  incomplete_results?: boolean;
  items?: Array<{
    path?: string;
    text_matches?: Array<{ fragment?: string }> | null;
  }> | null;
}

/** GitHub's code-search payload → neutral hits. Pure. */
export function mapSearchResults(
  payload: GithubSearchPayload,
): CodeSearchResult {
  return {
    supported: true,
    incomplete: payload.incomplete_results === true,
    hits: (payload.items ?? []).flatMap((item) => {
      if (!item.path) return [];
      const fragment = item.text_matches?.[0]?.fragment;
      return [{ path: item.path, ...(fragment ? { fragment } : {}) }];
    }),
  };
}

export class GithubInsightsClient implements RepoInsightsClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly apiBaseUrl: string;
  private readonly owner: string;
  private readonly name: string;
  private defaultBranch: string | null = null;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.apiBaseUrl = githubApiBaseUrl(params.repo.host);
    const { owner, name } = splitOwnerName(params.repo);
    this.owner = owner;
    this.name = name;
  }

  capabilities(): RepoInsightsCapabilities {
    return { codeSearch: true, lineStats: "inline" };
  }

  private async token(force?: boolean): Promise<string | null> {
    const issued = await this.tokenSource.get(
      force ? { forceRefresh: true } : undefined,
    );
    return issued?.token ?? null;
  }

  private get missingTokenMessage(): string {
    return `No usable GitHub token for ${this.repo.path}; reconnect the account`;
  }

  private async requireToken(): Promise<string> {
    const token = await this.token();
    if (token) return token;
    throw new GitProviderError({
      provider: "github",
      status: 401,
      message: this.missingTokenMessage,
    });
  }

  private graphql<T>(args: {
    query: string;
    variables: Record<string, unknown>;
    label: string;
    operation: string;
  }): Promise<T> {
    return githubGraphqlRequest<T>({
      getToken: (force) => this.token(force),
      missingTokenMessage: this.missingTokenMessage,
      ...args,
    });
  }

  private get repoBase(): string {
    return `${this.apiBaseUrl}/repos/${this.owner}/${this.name}`;
  }

  private async resolveDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const res = await githubFetch(this.repoBase, {
      token: await this.requireToken(),
      operation: "insights_repo",
    });
    if (!res.ok) throw await githubFailure(res, "insights_repo");
    const repo = await githubJson<{ default_branch?: string | null }>(
      res,
      "insights_repo",
    );
    if (!repo.default_branch) {
      throw new GitProviderError({
        provider: "github",
        status: 409,
        message: `GitHub repository ${this.repo.path} has no default branch (empty repository)`,
      });
    }
    this.defaultBranch = repo.default_branch;
    return this.defaultBranch;
  }

  async listTree(params: ListTreeParams = {}): Promise<RepoTreeListing> {
    const maxEntries = cappedLimit(
      params.maxEntries,
      DEFAULT_TREE_ENTRIES,
      MAX_TREE_ENTRIES,
    );
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const res = await githubFetch(
      `${this.repoBase}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { token: await this.requireToken(), operation: "insights_tree" },
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { ref, entries: [], truncated: false };
    }
    if (!res.ok) throw await githubFailure(res, "insights_tree");
    const raw = await githubJson<{
      tree?: GithubRawTreeEntry[] | null;
      truncated?: boolean;
    }>(res, "insights_tree");
    return { ref, ...mapTreeEntries(raw, maxEntries) };
  }

  async readFile(params: ReadFileParams): Promise<RepoFileContent> {
    const maxBytes = cappedLimit(
      params.maxBytes,
      DEFAULT_FILE_BYTES,
      MAX_FILE_BYTES,
    );
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const query = new URLSearchParams({ ref });
    const res = await githubFetch(
      `${this.repoBase}/contents/${encodeFilePath(params.path)}?${query}`,
      {
        token: await this.requireToken(),
        operation: "insights_file",
        accept: "application/vnd.github.raw",
      },
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { content: null, size: null, truncated: false };
    }
    if (!res.ok) throw await githubFailure(res, "insights_file");
    return readCappedBody(res, maxBytes);
  }

  async searchCode(params: SearchCodeParams): Promise<CodeSearchResult> {
    const limit = cappedLimit(params.limit, 20, MAX_SEARCH_HITS);
    const query = new URLSearchParams({
      q: `${params.query} repo:${this.repo.path}`,
      per_page: String(limit),
    });
    const res = await githubFetch(`${this.apiBaseUrl}/search/code?${query}`, {
      token: await this.requireToken(),
      operation: "insights_search",
      accept: "application/vnd.github.text-match+json",
    });
    if (res.status === 422) {
      await res.body?.cancel().catch(() => {});
      return { supported: true, incomplete: false, hits: [] };
    }
    if (!res.ok) throw await githubFailure(res, "insights_search");
    return mapSearchResults(
      await githubJson<GithubSearchPayload>(res, "insights_search"),
    );
  }

  async listChangeRequests(
    params: ListChangeRequestsParams,
  ): Promise<ChangeRequestHistoryPage> {
    const limit = cappedLimit(params.limit, 50, MAX_CHANGE_REQUEST_PAGE);
    const payload = await this.graphql<PullRequestsPayload>({
      query: pullRequestsQuery({
        includeCommits: params.includeCommits === true,
        includeStats: params.includeStats === true,
      }),
      variables: {
        owner: this.owner,
        name: this.name,
        limit,
        after: params.cursor ?? null,
        states: pullRequestStates(params.state),
      },
      label: `change request history for ${this.repo.path}`,
      operation: "insights_change_requests",
    });
    const page = payload.repository?.pullRequests;
    if (!page) return { items: [], nextCursor: null };
    const { items, reachedWindowEnd } = withinUpdatedWindow(
      (page.nodes ?? []).map(mapPullRequest),
      params.updatedAfter,
    );
    return {
      items,
      nextCursor:
        reachedWindowEnd || !page.pageInfo.hasNextPage
          ? null
          : page.pageInfo.endCursor,
    };
  }

  async listCommits(params: ListCommitsParams): Promise<RepoCommitPage> {
    const limit = cappedLimit(params.limit, MAX_COMMIT_PAGE, MAX_COMMIT_PAGE);
    const hasRef = params.ref !== undefined;
    const payload = await this.graphql<CommitsPayload>({
      query: commitHistoryQuery(hasRef),
      variables: {
        owner: this.owner,
        name: this.name,
        since: params.since,
        limit,
        after: params.cursor ?? null,
        ...(hasRef ? { ref: params.ref } : {}),
      },
      label: `commit history for ${this.repo.path}`,
      operation: "insights_commits",
    });
    const target = hasRef
      ? payload.repository?.ref?.target
      : payload.repository?.defaultBranchRef?.target;
    const history = target?.history;
    if (!history) return { items: [], nextCursor: null };
    return {
      items: (history.nodes ?? []).map(mapCommit),
      nextCursor: history.pageInfo.hasNextPage
        ? history.pageInfo.endCursor
        : null,
    };
  }
}

/** Repository-relative paths keep their separators; every segment is escaped. */
function encodeFilePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
