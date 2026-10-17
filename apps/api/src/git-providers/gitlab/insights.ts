/**
 * `RepoInsightsClient` over GitLab REST v4.
 *
 * Two honest gaps, stated here rather than papered over:
 *
 * - **Line stats.** A merge request payload carries no additions/deletions, and
 *   the only way to get them is `/changes` or `/diffs`, which downloads the
 *   whole diff of every merge request in the window. That is not a cost this
 *   interface pays, so `lineStats` is `"none"` and the fields stay null. A
 *   consumer reports itself blocked; it does not estimate.
 * - **Code search.** `/projects/:id/search?scope=blobs` exists on every
 *   instance, but an administrator can turn search off and a project on an
 *   instance without the search indexer answers 400 or 403. That is reported as
 *   `supported: false`, not as a failure.
 *
 * Commits per merge request are a real per-row call, so they are fetched only
 * when asked for, bounded at {@link COMMIT_FANOUT} in flight — an unbounded
 * `Promise.all` over a 50-row page is the burst a rate limiter exists to stop.
 */

import { mapBounded } from "@decocms/shared/std";
import { changeRequestUrl, type RepoRef } from "@decocms/shared/git-providers";
import { encodeProjectPath } from "./client";
import { gitlabApiBaseUrl, gitlabFailure, gitlabFetch } from "./http";
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
  pageFromCursor,
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

/** Concurrent per-merge-request calls when commits are asked for. */
const COMMIT_FANOUT = 4;
/** GitLab's own per-page ceiling. */
const PAGE_SIZE = 100;
/** Pages walked for one tree listing, so a provider that keeps handing back a
 *  cursor without rows cannot spin this loop forever. */
const MAX_TREE_PAGES = 40;

export interface GitlabMergeRequestRow {
  iid?: number;
  title?: string;
  web_url?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  target_branch?: string;
  source_branch?: string;
  author?: {
    username?: string | null;
    bot?: boolean | null;
  } | null;
}

export interface GitlabCommitRow {
  id?: string;
  committed_date?: string;
  created_at?: string;
  title?: string;
  message?: string;
  author_name?: string | null;
  author_email?: string | null;
}

interface GitlabTreeRow {
  path?: string;
  type?: string;
}

interface GitlabBlobHit {
  path?: string;
  data?: string;
}

/** GitLab's merge-request state vocabulary → the neutral one. Pure. */
export function mapMergeRequestState(
  state: string | undefined,
): ChangeRequestHistoryItem["state"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

/** The `state` query value for a caller's filter, or null to omit it. Pure. */
export function mergeRequestStateParam(
  state: ListChangeRequestsParams["state"],
): string | null {
  switch (state) {
    case "merged":
      return "merged";
    case "open":
      return "opened";
    case "all":
      return null;
  }
}

/** GitLab's merge request → the neutral history row. Pure. */
export function mapMergeRequest(
  row: GitlabMergeRequestRow,
  fallbackUrl: (iid: number) => string,
): ChangeRequestHistoryItem {
  const iid = row.iid ?? 0;
  const login = row.author?.username ?? "";
  return {
    number: iid,
    title: row.title ?? "",
    url: row.web_url ?? fallbackUrl(iid),
    state: mapMergeRequestState(row.state),
    author: {
      login,
      isBot: row.author?.bot === true || loginLooksLikeBot(login),
    },
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? row.created_at ?? "",
    mergedAt: row.merged_at ?? null,
    closedAt: row.closed_at ?? null,
    base: row.target_branch ?? "",
    head: row.source_branch ?? "",
    additions: null,
    deletions: null,
    commits: null,
  };
}

/** GitLab's commit row → the neutral commit. Pure. */
export function mapCommit(row: GitlabCommitRow): RepoCommit {
  return {
    sha: row.id ?? "",
    date: row.committed_date ?? row.created_at ?? "",
    message: row.title ?? firstLine(row.message ?? ""),
    author: {
      name: row.author_name ?? null,
      email: row.author_email ?? null,
      login: null,
    },
  };
}

function firstLine(message: string): string {
  const end = message.indexOf("\n");
  return end === -1 ? message : message.slice(0, end);
}

/**
 * The page GitLab says comes next, as this interface's cursor. GitLab answers
 * `x-next-page` with an empty string on the last page, which `Number("")` would
 * otherwise read as page 0.
 */
export function nextPageCursor(headers: Headers): string | null {
  const next = headers.get("x-next-page");
  if (!next) return null;
  const page = Number(next);
  return Number.isInteger(page) && page > 0 ? String(page) : null;
}

/** GitLab's tree rows → neutral entries. Pure. */
export function mapTreeRows(rows: GitlabTreeRow[]): RepoTreeEntry[] {
  return rows.flatMap((row) =>
    row.path
      ? [
          {
            path: row.path,
            type: row.type === "tree" ? "tree" : ("blob" as const),
          },
        ]
      : [],
  );
}

export class GitlabInsightsClient implements RepoInsightsClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly apiBase: string;
  private readonly projectBase: string;
  private defaultBranch: string | null = null;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.apiBase = gitlabApiBaseUrl(params.repo.host);
    this.projectBase = `/projects/${encodeProjectPath(params.repo.path)}`;
  }

  capabilities(): RepoInsightsCapabilities {
    return { codeSearch: true, lineStats: "none" };
  }

  private async token(): Promise<string> {
    const issued = await this.tokenSource.get();
    if (issued) return issued.token;
    throw new GitProviderError({
      provider: "gitlab",
      status: 401,
      message: `No usable GitLab token for ${this.repo.path}; reconnect the account`,
    });
  }

  /** One project-scoped REST call. Non-2xx throws except the `allow`ed statuses. */
  private async call(
    pathAndQuery: string,
    opts: { accept?: string; allow?: number[] } = {},
  ): Promise<Response> {
    const res = await gitlabFetch(
      `${this.apiBase}${this.projectBase}${pathAndQuery}`,
      await this.token(),
      { accept: opts.accept },
    );
    if (!res.ok && !opts.allow?.includes(res.status))
      throw await gitlabFailure(res);
    return res;
  }

  private async json<T>(pathAndQuery: string): Promise<T> {
    return (await (await this.call(pathAndQuery)).json()) as T;
  }

  private async rows<T>(pathAndQuery: string): Promise<{
    rows: T[];
    nextCursor: string | null;
  }> {
    const res = await this.call(pathAndQuery);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 502,
        message: `GitLab ${pathAndQuery} returned a non-array payload`,
      });
    }
    return { rows: body as T[], nextCursor: nextPageCursor(res.headers) };
  }

  private async resolveDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const project = await this.json<{ default_branch?: string | null }>("");
    if (!project.default_branch) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 409,
        message: `GitLab project ${this.repo.path} has no default branch (empty repository)`,
      });
    }
    this.defaultBranch = project.default_branch;
    return this.defaultBranch;
  }

  async listTree(params: ListTreeParams = {}): Promise<RepoTreeListing> {
    const maxEntries = cappedLimit(
      params.maxEntries,
      DEFAULT_TREE_ENTRIES,
      MAX_TREE_ENTRIES,
    );
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const entries: RepoTreeEntry[] = [];
    let cursor: string | null = "1";
    let visited = 0;
    while (cursor !== null && entries.length < maxEntries) {
      if (visited++ >= MAX_TREE_PAGES) break;
      const query = new URLSearchParams({
        ref,
        recursive: "true",
        per_page: String(PAGE_SIZE),
        page: cursor,
      });
      const page: { rows: GitlabTreeRow[]; nextCursor: string | null } =
        await this.rows<GitlabTreeRow>(`/repository/tree?${query}`);
      entries.push(...mapTreeRows(page.rows));
      cursor = page.nextCursor;
    }
    const truncated = entries.length > maxEntries || cursor !== null;
    return { ref, entries: entries.slice(0, maxEntries), truncated };
  }

  async readFile(params: ReadFileParams): Promise<RepoFileContent> {
    const maxBytes = cappedLimit(
      params.maxBytes,
      DEFAULT_FILE_BYTES,
      MAX_FILE_BYTES,
    );
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const query = new URLSearchParams({ ref });
    const res = await this.call(
      `/repository/files/${encodeFilePath(params.path)}/raw?${query}`,
      { allow: [404] },
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { content: null, size: null, truncated: false };
    }
    return readCappedBody(res, maxBytes);
  }

  async searchCode(params: SearchCodeParams): Promise<CodeSearchResult> {
    const limit = cappedLimit(params.limit, 20, MAX_SEARCH_HITS);
    const query = new URLSearchParams({
      scope: "blobs",
      search: params.query,
      per_page: String(limit),
    });
    const res = await this.call(`/search?${query}`, {
      allow: [400, 403, 404, 501],
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { supported: false, incomplete: false, hits: [] };
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body))
      return { supported: false, incomplete: false, hits: [] };
    return {
      supported: true,
      incomplete: body.length >= limit,
      hits: (body as GitlabBlobHit[]).flatMap((hit) =>
        hit.path
          ? [{ path: hit.path, ...(hit.data ? { fragment: hit.data } : {}) }]
          : [],
      ),
    };
  }

  async listChangeRequests(
    params: ListChangeRequestsParams,
  ): Promise<ChangeRequestHistoryPage> {
    const limit = cappedLimit(params.limit, 50, MAX_CHANGE_REQUEST_PAGE);
    const query = new URLSearchParams({
      order_by: "updated_at",
      sort: "desc",
      per_page: String(limit),
      page: String(pageFromCursor(params.cursor)),
    });
    const state = mergeRequestStateParam(params.state);
    if (state) query.set("state", state);
    if (params.updatedAfter) query.set("updated_after", params.updatedAfter);

    const page = await this.rows<GitlabMergeRequestRow>(
      `/merge_requests?${query}`,
    );
    const items = page.rows.map((row) =>
      mapMergeRequest(row, (iid) => changeRequestUrl(this.repo, iid)),
    );
    if (params.includeCommits !== true) {
      return { items, nextCursor: page.nextCursor };
    }
    const withCommits = await mapBounded(
      items,
      COMMIT_FANOUT,
      async (item) => ({
        ...item,
        commits: await this.mergeRequestCommits(item.number),
      }),
    );
    return { items: withCommits, nextCursor: page.nextCursor };
  }

  private async mergeRequestCommits(
    iid: number,
  ): Promise<ChangeRequestHistoryItem["commits"]> {
    const { rows } = await this.rows<GitlabCommitRow>(
      `/merge_requests/${iid}/commits?per_page=${PAGE_SIZE}`,
    );
    const items = rows.flatMap((row) =>
      row.id
        ? [{ sha: row.id, date: row.committed_date ?? row.created_at ?? "" }]
        : [],
    );
    return { count: items.length, items };
  }

  async listCommits(params: ListCommitsParams): Promise<RepoCommitPage> {
    const limit = cappedLimit(params.limit, MAX_COMMIT_PAGE, MAX_COMMIT_PAGE);
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const query = new URLSearchParams({
      ref_name: ref,
      since: params.since,
      per_page: String(limit),
      page: String(pageFromCursor(params.cursor)),
    });
    const page = await this.rows<GitlabCommitRow>(
      `/repository/commits?${query}`,
    );
    return { items: page.rows.map(mapCommit), nextCursor: page.nextCursor };
  }
}

/** A repository-relative path is ONE GitLab path segment: slashes encode too. */
function encodeFilePath(path: string): string {
  return encodeURIComponent(path);
}
