/**
 * `IssueClient` over GitHub REST.
 *
 * GitHub's issues endpoints also return pull requests (every pull request is
 * an issue there, marked by a `pull_request` key). They are filtered out, so a
 * listing may need more than one page to fill `limit`; `MAX_PAGES` bounds that
 * walk on a repository whose recent activity is all pull requests.
 */

import { type RepoRef, splitOwnerName } from "@decocms/shared/git-providers";
import {
  githubApiBaseUrl,
  githubFailure,
  githubFetch,
  githubJson,
} from "./http";
import { GitProviderError, type TokenSource } from "../types";
import {
  type Issue,
  type IssueClient,
  type IssueCloseReason,
  MAX_ISSUES_LISTED,
} from "../issues";

const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export interface RawIssue {
  number?: number | null;
  html_url?: string | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  user?: { login?: string | null } | null;
  labels?: Array<string | { name?: string | null } | null> | null;
  comments?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  pull_request?: unknown;
}

/** Map a REST issue payload, or null for a pull request. Pure — unit-tested. */
export function mapIssue(raw: RawIssue): Issue | null {
  if (raw.pull_request != null || typeof raw.number !== "number") return null;
  return {
    number: raw.number,
    url: raw.html_url ?? "",
    title: raw.title ?? "",
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    author: raw.user?.login ?? null,
    labels: (raw.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label?.name;
      return name ? [name] : [];
    }),
    comments: raw.comments ?? 0,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

export class GithubIssueClient implements IssueClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly base: string;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    const { owner, name } = splitOwnerName(params.repo);
    this.base = `${githubApiBaseUrl(params.repo.host)}/repos/${owner}/${name}`;
  }

  private async request(
    path: string,
    init: { method?: "POST" | "PATCH"; body?: unknown; operation: string },
  ): Promise<Response> {
    const issued = await this.tokenSource.get();
    if (!issued?.token) {
      throw new GitProviderError({
        provider: "github",
        status: 401,
        message: `No usable GitHub token for ${this.repo.path}; reconnect the account`,
      });
    }
    return githubFetch(`${this.base}${path}`, { ...init, token: issued.token });
  }

  async listOpen(limit: number): Promise<Issue[]> {
    const wanted = Math.min(Math.max(limit, 0), MAX_ISSUES_LISTED);
    const issues: Issue[] = [];
    for (let page = 1; page <= MAX_PAGES && issues.length < wanted; page++) {
      const operation = "issue_list";
      const res = await this.request(
        `/issues?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
        { operation },
      );
      if (!res.ok) throw await githubFailure(res, operation);
      const rows = await githubJson<RawIssue[]>(res, operation);
      for (const row of rows) {
        const issue = mapIssue(row);
        if (issue && issues.length < wanted) issues.push(issue);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    return issues;
  }

  async read(number: number): Promise<Issue | null> {
    const operation = "issue_read";
    const res = await this.request(`/issues/${number}`, { operation });
    // 410: deleted, or issues turned off since it was opened.
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await githubFailure(res, operation);
    return mapIssue(await githubJson<RawIssue>(res, operation));
  }

  async comment(number: number, body: string): Promise<void> {
    const operation = "issue_comment";
    const res = await this.request(`/issues/${number}/comments`, {
      method: "POST",
      body: { body },
      operation,
    });
    if (!res.ok) throw await githubFailure(res, operation);
    await res.body?.cancel().catch(() => {});
  }

  async close(number: number, reason: IssueCloseReason): Promise<void> {
    const operation = "issue_close";
    const res = await this.request(`/issues/${number}`, {
      method: "PATCH",
      body: { state: "closed", state_reason: reason },
      operation,
    });
    if (!res.ok) throw await githubFailure(res, operation);
    await res.body?.cancel().catch(() => {});
  }
}
