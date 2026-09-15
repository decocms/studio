/**
 * `RepoInsightsClient` over Bitbucket Cloud REST 2.0.
 *
 * Bitbucket is the provider that forces this interface's honesty rules to be
 * real, because two things it does not carry on the pull request object are
 * exactly what an audit wants:
 *
 * - **When it merged.** The payload has a `merge_commit` hash but no merge
 *   timestamp, and `updated_on` is when someone last commented. Substituting
 *   the latter would silently turn "merged nine days after opening" into
 *   "merged whenever the last bot comment landed". So the merge commit's date is
 *   fetched in the same bounded fan-out that fetches commits — and when the
 *   caller did not ask for commits, `mergedAt` is null and a lead-time measure
 *   reports itself blocked.
 * - **How many lines it touched.** Only `/diffstat` knows, one call per pull
 *   request, and only in full: a diffstat cut short by the page cap sums to a
 *   number smaller than the truth, which is worse than no number. That case
 *   answers null.
 *
 * Bitbucket Cloud only; `assertBitbucketCloud` refuses a Data Center host up
 * front, as everywhere else under `bitbucket/`.
 */

import { mapBounded } from "@decocms/shared/std";
import { changeRequestUrl, type RepoRef } from "@decocms/shared/git-providers";
import { repositoryApiPath, splitBitbucketPath } from "./client";
import {
  assertBitbucketCloud,
  BITBUCKET_API_BASE,
  type BitbucketPage,
  bbqString,
  bitbucketFailure,
  bitbucketFetch,
} from "./http";
import { GitProviderError, type TokenSource } from "../types";
import {
  cappedLimit,
  type ChangeRequestHistoryItem,
  type ChangeRequestHistoryPage,
  type CodeSearchResult,
  DEFAULT_FILE_BYTES,
  DEFAULT_TREE_ENTRIES,
  encodeRepoFilePath,
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

/** Concurrent per-pull-request calls when commits or stats are asked for. */
const PR_FANOUT = 4;
/** Bitbucket's own per-page ceiling. */
const PAGE_SIZE = 100;
/** How deep `/src` recurses in one listing — deeper than any real source tree. */
const TREE_MAX_DEPTH = 30;
/** Pages walked for one tree listing, so a provider that keeps handing back a
 *  cursor without rows cannot spin this loop forever. */
const MAX_TREE_PAGES = 40;
/** Pages of `/diffstat` read before a sum would be a partial lie. */
const MAX_DIFFSTAT_PAGES = 5;
/** Pages walked while filtering commits by date client-side. */
const MAX_COMMIT_PAGES = 20;

export interface BitbucketPullRequestRow {
  id?: number;
  title?: string;
  state?: string;
  created_on?: string;
  updated_on?: string;
  links?: { html?: { href?: string | null } | null } | null;
  source?: { branch?: { name?: string | null } | null } | null;
  destination?: { branch?: { name?: string | null } | null } | null;
  author?: {
    nickname?: string | null;
    display_name?: string | null;
  } | null;
  merge_commit?: { hash?: string | null } | null;
}

export interface BitbucketCommitRow {
  hash?: string;
  date?: string;
  message?: string;
  author?: {
    raw?: string | null;
    user?: { nickname?: string | null } | null;
  } | null;
}

interface BitbucketSrcRow {
  path?: string;
  type?: string;
  size?: number;
}

interface BitbucketDiffstatRow {
  lines_added?: number;
  lines_removed?: number;
}

interface BitbucketSearchRow {
  file?: { path?: string | null } | null;
  content_matches?: Array<{
    lines?: Array<{ segments?: Array<{ text?: string }> | null }> | null;
  }> | null;
}

/** Bitbucket's pull request states → the neutral vocabulary. Pure. */
export function mapPullRequestState(
  state: string | undefined,
): ChangeRequestHistoryItem["state"] {
  if (state === "MERGED") return "merged";
  if (state === "OPEN") return "open";
  return "closed";
}

/**
 * The `state` values to send for a caller's filter. `all` must name every state
 * explicitly — Bitbucket's default is OPEN alone, so omitting the parameter
 * would quietly answer "all" with only the open ones.
 */
export function pullRequestStateParams(
  state: ListChangeRequestsParams["state"],
): string[] {
  switch (state) {
    case "merged":
      return ["MERGED"];
    case "open":
      return ["OPEN"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

/**
 * The `page` value Bitbucket's `next` link carries, verbatim. Numeric for most
 * listings and an opaque token for commits, and never followed as a URL — it
 * goes back into a `page=` parameter on a URL this client builds, so a cursor
 * a caller echoes back can only ever page this same endpoint.
 */
export function nextPageToken(page: BitbucketPage<unknown>): string | null {
  if (!page.next) return null;
  try {
    return new URL(page.next).searchParams.get("page");
  } catch {
    return null;
  }
}

/** `Name <email>` — Bitbucket's raw git author line. Pure. */
export function parseRawAuthor(raw: string | null | undefined): {
  name: string | null;
  email: string | null;
} {
  if (!raw) return { name: null, email: null };
  const match = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  if (!match) return { name: raw.trim() || null, email: null };
  return { name: match[1] || null, email: match[2] || null };
}

/** Bitbucket's pull request → the neutral history row. Pure. */
export function mapPullRequest(
  row: BitbucketPullRequestRow,
  fallbackUrl: (id: number) => string,
): ChangeRequestHistoryItem {
  const id = row.id ?? 0;
  const login = row.author?.nickname ?? row.author?.display_name ?? "";
  return {
    number: id,
    title: row.title ?? "",
    url: row.links?.html?.href ?? fallbackUrl(id),
    state: mapPullRequestState(row.state),
    author: { login, isBot: loginLooksLikeBot(login) },
    createdAt: row.created_on ?? "",
    updatedAt: row.updated_on ?? row.created_on ?? "",
    mergedAt: null,
    closedAt: null,
    base: row.destination?.branch?.name ?? "",
    head: row.source?.branch?.name ?? "",
    additions: null,
    deletions: null,
    commits: null,
  };
}

/** Bitbucket's commit → the neutral commit. Pure. */
export function mapCommit(row: BitbucketCommitRow): RepoCommit {
  const { name, email } = parseRawAuthor(row.author?.raw);
  return {
    sha: row.hash ?? "",
    date: row.date ?? "",
    message: firstLine(row.message ?? ""),
    author: { name, email, login: row.author?.user?.nickname ?? null },
  };
}

function firstLine(message: string): string {
  const end = message.indexOf("\n");
  return end === -1 ? message : message.slice(0, end);
}

/** Bitbucket's `/src` rows → neutral entries. Pure. */
export function mapSrcRows(rows: BitbucketSrcRow[]): RepoTreeEntry[] {
  return rows.flatMap((row) => {
    if (!row.path) return [];
    const type = row.type === "commit_directory" ? "tree" : "blob";
    return [
      {
        path: row.path,
        type: type as RepoTreeEntry["type"],
        ...(typeof row.size === "number" ? { size: row.size } : {}),
      },
    ];
  });
}

/** Bitbucket's code-search rows → neutral hits. Pure. */
export function mapSearchRows(
  rows: BitbucketSearchRow[],
): CodeSearchResult["hits"] {
  return rows.flatMap((row) => {
    const path = row.file?.path;
    if (!path) return [];
    const fragment = row.content_matches?.[0]?.lines
      ?.flatMap(
        (line) => line.segments?.map((segment) => segment.text ?? "") ?? [],
      )
      .join("");
    return [{ path, ...(fragment ? { fragment } : {}) }];
  });
}

export class BitbucketInsightsClient implements RepoInsightsClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly repoBase: string;
  private readonly workspace: string;
  private readonly slug: string;
  private defaultBranch: string | null = null;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    assertBitbucketCloud(params.repo.host);
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.repoBase = repositoryApiPath(params.repo);
    const { workspace, slug } = splitBitbucketPath(params.repo.path);
    this.workspace = workspace;
    this.slug = slug;
  }

  capabilities(): RepoInsightsCapabilities {
    return { codeSearch: true, lineStats: "per_request" };
  }

  private async token(): Promise<string> {
    const issued = await this.tokenSource.get();
    if (issued) return issued.token;
    throw new GitProviderError({
      provider: "bitbucket",
      status: 401,
      message: `No usable Bitbucket token for ${this.repo.path}; reconnect the account`,
    });
  }

  /** One REST call. Non-2xx throws except the `allow`ed statuses. */
  private async callAt(
    url: string,
    opts: { allow?: number[] } = {},
  ): Promise<Response> {
    const res = await bitbucketFetch(url, await this.token());
    if (!res.ok && !opts.allow?.includes(res.status)) {
      throw await bitbucketFailure(res);
    }
    return res;
  }

  private call(
    pathAndQuery: string,
    opts?: { allow?: number[] },
  ): Promise<Response> {
    return this.callAt(`${BITBUCKET_API_BASE}${pathAndQuery}`, opts);
  }

  private async json<T>(pathAndQuery: string): Promise<T> {
    return (await (await this.call(pathAndQuery)).json()) as T;
  }

  private async resolveDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const repository = await this.json<{
      mainbranch?: { name?: string | null } | null;
    }>(this.repoBase);
    if (!repository.mainbranch?.name) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 409,
        message: `Bitbucket repository ${this.repo.path} has no main branch (empty repository)`,
      });
    }
    this.defaultBranch = repository.mainbranch.name;
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
    let cursor: string | null = null;
    let exhausted = false;
    let visited = 0;
    while (entries.length < maxEntries) {
      if (visited++ >= MAX_TREE_PAGES) break;
      const query = new URLSearchParams({
        max_depth: String(TREE_MAX_DEPTH),
        pagelen: String(PAGE_SIZE),
      });
      if (cursor) query.set("page", cursor);
      const page = await this.json<BitbucketPage<BitbucketSrcRow>>(
        `${this.repoBase}/src/${encodeRef(ref)}/?${query}`,
      );
      entries.push(...mapSrcRows(page.values ?? []));
      cursor = nextPageToken(page);
      if (cursor === null) {
        exhausted = true;
        break;
      }
    }
    return {
      ref,
      entries: entries.slice(0, maxEntries),
      truncated: !exhausted || entries.length > maxEntries,
    };
  }

  async readFile(params: ReadFileParams): Promise<RepoFileContent> {
    const maxBytes = cappedLimit(
      params.maxBytes,
      DEFAULT_FILE_BYTES,
      MAX_FILE_BYTES,
    );
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const res = await this.call(
      `${this.repoBase}/src/${encodeRef(ref)}/${encodeRepoFilePath(params.path)}`,
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
      search_query: `${params.query} repo:${this.slug}`,
      pagelen: String(limit),
    });
    const res = await this.call(
      `/workspaces/${encodeURIComponent(this.workspace)}/search/code?${query}`,
      { allow: [400, 403, 404] },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { supported: false, incomplete: false, hits: [] };
    }
    const page = (await res.json()) as BitbucketPage<BitbucketSearchRow>;
    return {
      supported: true,
      incomplete: page.next != null,
      hits: mapSearchRows(page.values ?? []),
    };
  }

  async listChangeRequests(
    params: ListChangeRequestsParams,
  ): Promise<ChangeRequestHistoryPage> {
    const limit = cappedLimit(params.limit, 50, MAX_CHANGE_REQUEST_PAGE);
    const query = new URLSearchParams({
      sort: "-updated_on",
      pagelen: String(limit),
    });
    for (const state of pullRequestStateParams(params.state)) {
      query.append("state", state);
    }
    if (params.updatedAfter) {
      query.set("q", `updated_on >= ${bbqString(params.updatedAfter)}`);
    }
    if (params.cursor) query.set("page", params.cursor);

    const page = await this.json<BitbucketPage<BitbucketPullRequestRow>>(
      `${this.repoBase}/pullrequests?${query}`,
    );
    const rows = page.values ?? [];
    const items = rows.map((row) =>
      mapPullRequest(row, (id) => changeRequestUrl(this.repo, id)),
    );
    const needsFanout =
      params.includeCommits === true || params.includeStats === true;
    if (!needsFanout) {
      return { items, nextCursor: nextPageToken(page) };
    }
    const enriched = await mapBounded(
      items.map((item, index) => ({ item, row: rows[index] })),
      PR_FANOUT,
      async ({ item, row }) => ({
        ...item,
        ...(params.includeCommits === true
          ? {
              commits: await this.pullRequestCommits(item.number),
              mergedAt: await this.mergeCommitDate(row?.merge_commit?.hash),
            }
          : {}),
        ...(params.includeStats === true
          ? await this.pullRequestStats(item.number)
          : {}),
      }),
    );
    return { items: enriched, nextCursor: nextPageToken(page) };
  }

  private async pullRequestCommits(
    id: number,
  ): Promise<ChangeRequestHistoryItem["commits"]> {
    const page = await this.json<BitbucketPage<BitbucketCommitRow>>(
      `${this.repoBase}/pullrequests/${id}/commits?pagelen=${PAGE_SIZE}`,
    );
    const items = (page.values ?? []).flatMap((row) =>
      row.hash ? [{ sha: row.hash, date: row.date ?? "" }] : [],
    );
    return { count: page.size ?? items.length, items };
  }

  /** The merge commit's date — the only place Bitbucket records when a pull request landed. */
  private async mergeCommitDate(
    hash: string | null | undefined,
  ): Promise<string | null> {
    if (!hash) return null;
    const res = await this.call(
      `${this.repoBase}/commit/${encodeURIComponent(hash)}`,
      { allow: [404] },
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const commit = (await res.json()) as BitbucketCommitRow;
    return commit.date ?? null;
  }

  /** Summed diffstat, or nulls when the diff is larger than this walk reads. */
  private async pullRequestStats(
    id: number,
  ): Promise<{ additions: number | null; deletions: number | null }> {
    let additions = 0;
    let deletions = 0;
    let cursor: string | null = null;
    for (let visited = 0; visited < MAX_DIFFSTAT_PAGES; visited++) {
      const query = new URLSearchParams({ pagelen: String(PAGE_SIZE) });
      if (cursor) query.set("page", cursor);
      const page: BitbucketPage<BitbucketDiffstatRow> = await this.json<
        BitbucketPage<BitbucketDiffstatRow>
      >(`${this.repoBase}/pullrequests/${id}/diffstat?${query}`);
      for (const row of page.values ?? []) {
        additions += row.lines_added ?? 0;
        deletions += row.lines_removed ?? 0;
      }
      cursor = nextPageToken(page);
      if (cursor === null) return { additions, deletions };
    }
    return { additions: null, deletions: null };
  }

  async listCommits(params: ListCommitsParams): Promise<RepoCommitPage> {
    const limit = cappedLimit(params.limit, MAX_COMMIT_PAGE, MAX_COMMIT_PAGE);
    const ref = params.ref ?? (await this.resolveDefaultBranch());
    const floor = Date.parse(params.since);
    const items: RepoCommit[] = [];
    let cursor: string | null = params.cursor ?? null;

    for (let visited = 0; visited < MAX_COMMIT_PAGES; visited++) {
      const query = new URLSearchParams({
        pagelen: String(Math.min(limit, PAGE_SIZE)),
      });
      if (cursor) query.set("page", cursor);
      const page = await this.json<BitbucketPage<BitbucketCommitRow>>(
        `${this.repoBase}/commits/${encodeRef(ref)}?${query}`,
      );
      for (const row of page.values ?? []) {
        const commit = mapCommit(row);
        if (Number.isFinite(floor) && Date.parse(commit.date) < floor) {
          return { items, nextCursor: null };
        }
        items.push(commit);
      }
      cursor = nextPageToken(page);
      if (cursor === null) return { items, nextCursor: null };
      if (items.length >= limit) return { items, nextCursor: cursor };
    }
    return { items, nextCursor: cursor };
  }
}

/** Branch names and revisions are one path segment: slashes encode too. */
function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}
