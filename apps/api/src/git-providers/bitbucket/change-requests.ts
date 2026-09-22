/**
 * `ChangeRequestClient` over Bitbucket Cloud's REST 2.0 API.
 *
 * A Bitbucket pull request is the same object GitHub's is, so the read side
 * maps almost field-for-field. Where Bitbucket carries less on the single
 * read than the others, the neutral field answers "unknown" rather than a
 * guess: the pull request payload has no mergeability, no CI rollup and no
 * merge timestamp, so the cheap read reports `conflicting: null` and
 * `checks: null`, and the detailed read pays for them — the pull request's
 * diffstat names conflicting files, and the head commit's statuses are the CI
 * signal. `mergedAt` is the last update of a merged pull request, which is
 * the merge in the overwhelming case and never earlier than it.
 *
 * Bitbucket Cloud only — see `http.ts`.
 */

import { changeRequestUrl, type RepoRef } from "@decocms/shared/git-providers";
import { retry, RetryError } from "@decocms/shared/std";
import { GitProviderError, type TokenSource } from "../types";
import {
  type ChangeRequest,
  type ChangeRequestClient,
  type ChangeRequestComment,
  type ChangeRequestDetail,
  ChangeRequestExists,
  type CheckConclusion,
  type CheckRun,
  type CheckState,
  type MergeOutcome,
  type MergeParams,
  type MergeRefusal,
  type OpenChangeRequestParams,
  summarizeChecks,
} from "../change-requests";
import { repositoryApiPath } from "./client";
import {
  BITBUCKET_API_BASE,
  bbqString,
  bitbucketFailure,
  bitbucketFetch,
  type BitbucketPage,
} from "./http";

/** Bitbucket caps pull request listings at 50 per page; other listings at 100. */
const PR_PAGE_SIZE = 50;
const PAGE_SIZE = 100;
/** Merged pull requests scanned when looking for the latest merge into a branch. */
const MERGED_SCANNED = 20;

export interface RawPullRequest {
  id?: number | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  draft?: boolean | null;
  updated_on?: string | null;
  destination?: { branch?: { name?: string | null } | null } | null;
  source?: {
    branch?: { name?: string | null } | null;
    commit?: { hash?: string | null } | null;
    repository?: { full_name?: string | null } | null;
  } | null;
  author?: { nickname?: string | null } | null;
  merge_commit?: { hash?: string | null } | null;
  links?: { html?: { href?: string | null } | null } | null;
  participants?: Array<{ state?: string | null }> | null;
}

/** Bitbucket's four lifecycle values, in the neutral vocabulary. */
export function mapState(state: unknown): ChangeRequest["state"] {
  if (state === "MERGED") return "merged";
  if (state === "DECLINED" || state === "SUPERSEDED") return "closed";
  return "open";
}

/**
 * A commit status, split into the state/conclusion pair a reader sees. Pure —
 * unit-tested. `STOPPED` reads as cancelled, and therefore red, on purpose: a
 * build that did not finish is not evidence the head is good.
 */
export function mapStatusState(state: unknown): {
  state: CheckState;
  conclusion: CheckConclusion | null;
} {
  switch (state) {
    case "SUCCESSFUL":
      return { state: "completed", conclusion: "success" };
    case "FAILED":
      return { state: "completed", conclusion: "failure" };
    case "STOPPED":
      return { state: "completed", conclusion: "cancelled" };
    case "INPROGRESS":
      return { state: "running", conclusion: null };
    default:
      return { state: "queued", conclusion: null };
  }
}

export interface RawCommitStatus {
  key?: string | null;
  name?: string | null;
  state?: string | null;
  url?: string | null;
  description?: string | null;
  created_on?: string | null;
  updated_on?: string | null;
}

/**
 * A commit status as a run. Bitbucket has no run object: a status is a link
 * plus a state, so `id` is its key (stable per build system), the duration is
 * the gap between its creation and its last update once it has finished, and
 * its description is the only report it carries.
 */
export function mapCommitStatus(status: RawCommitStatus): CheckRun {
  const { state, conclusion } = mapStatusState(status.state);
  const started = status.created_on ? Date.parse(status.created_on) : NaN;
  const finished = status.updated_on ? Date.parse(status.updated_on) : NaN;
  return {
    id: status.key ?? null,
    name: status.name ?? status.key ?? "",
    state,
    conclusion,
    url: status.url ?? null,
    durationMs:
      state === "completed" &&
      Number.isFinite(started) &&
      Number.isFinite(finished)
        ? Math.max(0, finished - started)
        : null,
    summary: status.description ?? null,
  };
}

export interface RawComment {
  id?: number | null;
  content?: { raw?: string | null } | null;
  user?: { nickname?: string | null } | null;
  created_on?: string | null;
  updated_on?: string | null;
  deleted?: boolean | null;
  inline?: { path?: string | null } | null;
  parent?: { id?: number | null } | null;
  resolution?: unknown;
  links?: { html?: { href?: string | null } | null } | null;
}

/**
 * The comments on the pull request itself. Inline comments are review
 * threads on a file and line — a different thing, counted by
 * {@link countUnresolved} — and a deleted comment is a tombstone.
 */
export function mapComments(
  comments: RawComment[],
  crUrl: string,
): ChangeRequestComment[] {
  return comments
    .filter(
      (comment) =>
        comment.deleted !== true &&
        !comment.inline &&
        typeof comment.content?.raw === "string",
    )
    .map((comment) => ({
      id: String(comment.id ?? 0),
      author: comment.user?.nickname ?? "",
      body: comment.content?.raw ?? "",
      createdAt: comment.created_on ?? "",
      updatedAt: comment.updated_on ?? comment.created_on ?? "",
      url:
        comment.links?.html?.href ??
        (comment.id == null ? crUrl : `${crUrl}#comment-${comment.id}`),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Review threads still open. Only an inline comment can be resolved on
 * Bitbucket, a thread is its top-level comment (no `parent`), and resolution
 * is recorded on that comment — so an unresolved thread is a live, top-level
 * inline comment with no `resolution`.
 */
export function countUnresolved(comments: RawComment[]): number {
  let count = 0;
  for (const comment of comments) {
    if (comment.deleted === true) continue;
    if (!comment.inline || comment.parent) continue;
    if (comment.resolution == null) count += 1;
  }
  return count;
}

export interface RawDiffstatEntry {
  status?: string | null;
}

/**
 * Whether the pull request's diffstat reports a conflict. Bitbucket computes
 * mergeability lazily and reports it here — as an entry whose status is
 * "merge conflict" — rather than on the pull request. Pure — unit-tested.
 */
export function conflictFromDiffstat(
  entries: RawDiffstatEntry[] | null,
): boolean | null {
  if (entries === null) return null;
  return entries.some((entry) => entry.status === "merge conflict");
}

/** Someone asked for changes — the only review decision Bitbucket reports as a state. */
export function reviewBlockedFrom(pr: Pick<RawPullRequest, "participants">) {
  return (pr.participants ?? []).some(
    (participant) => participant.state === "changes_requested",
  );
}

/**
 * True when a merge refusal is Bitbucket saying the branch does not apply.
 * Pure — unit-tested. Bitbucket's refusal prose names the conflict when that
 * is the reason, which is why the refusal path can classify without a second
 * read in the common case.
 */
export function isConflictRefusal(message: string): boolean {
  return /conflict/i.test(message);
}

export class BitbucketChangeRequestClient implements ChangeRequestClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly repoBase: string;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.repoBase = `${BITBUCKET_API_BASE}${repositoryApiPath(params.repo)}`;
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

  /** One REST call under the repository. 404 answers null; other non-2xx throws. */
  private async call(
    pathAndQuery: string,
    init: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      accept?: string;
    } = {},
  ): Promise<Response | null> {
    const res = await bitbucketFetch(
      `${this.repoBase}${pathAndQuery}`,
      await this.token(),
      init,
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await bitbucketFailure(res);
    return res;
  }

  private async json<T>(
    pathAndQuery: string,
    init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T | null> {
    const res = await this.call(pathAndQuery, init);
    return res === null ? null : ((await res.json()) as T);
  }

  private async values<T>(pathAndQuery: string): Promise<T[] | null> {
    const page = await this.json<BitbucketPage<T>>(pathAndQuery);
    return page === null ? null : (page.values ?? []);
  }

  private prPath(id: number): string {
    return `/pullrequests/${id}`;
  }

  private map(pr: RawPullRequest): ChangeRequest {
    const id = pr.id ?? 0;
    const state = mapState(pr.state);
    return {
      number: id,
      url: pr.links?.html?.href ?? changeRequestUrl(this.repo, id),
      title: pr.title ?? "",
      body: pr.description ?? "",
      state,
      draft: pr.draft === true,
      mergedAt: state === "merged" ? (pr.updated_on ?? null) : null,
      updatedAt: pr.updated_on ?? null,
      base: pr.destination?.branch?.name ?? "main",
      head: pr.source?.branch?.name ?? "",
      // 12-char short hash on this payload; every commit endpoint accepts it.
      headSha: pr.source?.commit?.hash ?? "",
      // The source repository is on the payload; absent means the fork is gone.
      headRepoPath: pr.source?.repository?.full_name ?? null,
      author: pr.author?.nickname ?? "",
      conflicting: null,
      checks: null,
      changedFiles: null,
    };
  }

  async read(number: number): Promise<ChangeRequest | null> {
    const pr = await this.json<RawPullRequest>(this.prPath(number));
    return pr ? this.map(pr) : null;
  }

  /**
   * Bitbucket lists only OPEN pull requests unless every state is asked for
   * by name, and a merged one is exactly what a publish surface wants to see.
   */
  async readForBranch(branch: string): Promise<ChangeRequest | null> {
    const params = new URLSearchParams({
      q: `source.branch.name = ${bbqString(branch)}`,
      sort: "-updated_on",
      pagelen: "1",
    });
    for (const state of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) {
      params.append("state", state);
    }
    const rows = await this.values<RawPullRequest>(`/pullrequests?${params}`);
    const newest = rows?.[0];
    return newest ? this.map(newest) : null;
  }

  async readDetailed(
    target: { number: number } | { branch: string },
  ): Promise<ChangeRequestDetail | null> {
    const id =
      "number" in target
        ? target.number
        : ((await this.readForBranch(target.branch))?.number ?? null);
    if (id === null) return null;
    const pr = await this.json<RawPullRequest>(this.prPath(id));
    if (!pr) return null;
    const base = this.map(pr);

    const [statuses, comments, diffstat] = await Promise.all([
      base.headSha
        ? this.values<RawCommitStatus>(
            `/commit/${encodeURIComponent(base.headSha)}/statuses?pagelen=${PAGE_SIZE}`,
          )
        : Promise.resolve(null),
      this.values<RawComment>(
        `${this.prPath(id)}/comments?pagelen=${PAGE_SIZE}`,
      ),
      this.json<BitbucketPage<RawDiffstatEntry>>(
        `${this.prPath(id)}/diffstat?pagelen=${PAGE_SIZE}`,
      ),
    ]);

    const checkRuns = (statuses ?? []).map(mapCommitStatus);
    const diffEntries = diffstat?.values ?? null;
    return {
      ...base,
      conflicting: conflictFromDiffstat(diffEntries),
      checks: summarizeChecks(checkRuns),
      changedFiles: diffstat?.size ?? diffEntries?.length ?? null,
      checkRuns,
      comments: mapComments(comments ?? [], base.url),
      unresolvedConversations: countUnresolved(comments ?? []),
      reviewBlocked: reviewBlockedFrom(pr),
    };
  }

  async listOpen(limit: number): Promise<ChangeRequest[]> {
    const rows = await this.values<RawPullRequest>(
      `/pullrequests?state=OPEN&sort=-updated_on` +
        `&pagelen=${Math.min(limit, PR_PAGE_SIZE)}`,
    );
    return (rows ?? []).map((pr) => this.map(pr));
  }

  async lastMergedInto(base: string): Promise<ChangeRequest | null> {
    const params = new URLSearchParams({
      state: "MERGED",
      q: `destination.branch.name = ${bbqString(base)}`,
      sort: "-updated_on",
      pagelen: String(MERGED_SCANNED),
    });
    const rows = await this.values<RawPullRequest>(`/pullrequests?${params}`);
    let best: ChangeRequest | null = null;
    let bestAt = -Infinity;
    for (const raw of rows ?? []) {
      const pr = this.map(raw);
      const at = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (Number.isNaN(at) || at <= bestAt) continue;
      best = pr;
      bestAt = at;
    }
    return best;
  }

  /**
   * Bitbucket does not refuse a second pull request for a source/destination
   * pair that already has an open one: `POST /pullrequests` UPDATES it in
   * place, title and description included (verified against bitbucket.org).
   * So the duplicate is detected here, before anything is sent, and reported
   * as {@link ChangeRequestExists} the way the other providers' refusals are.
   */
  async open(params: OpenChangeRequestParams): Promise<ChangeRequest> {
    const existing = await this.openFor(params.head, params.base);
    if (existing) {
      throw new ChangeRequestExists(
        `Bitbucket already has an open pull request from ${params.head} to ${params.base}: #${existing.number}`,
        existing,
      );
    }
    const res = await bitbucketFetch(
      `${this.repoBase}/pullrequests`,
      await this.token(),
      {
        method: "POST",
        body: {
          title: params.title,
          description: params.body || undefined,
          source: { branch: { name: params.head } },
          destination: { branch: { name: params.base } },
        },
      },
    );
    if (res.ok) return this.map((await res.json()) as RawPullRequest);
    throw await bitbucketFailure(res);
  }

  /** The open pull request proposing `head` onto `base`, if any. */
  private async openFor(
    head: string,
    base: string,
  ): Promise<ChangeRequest | null> {
    const params = new URLSearchParams({
      state: "OPEN",
      q: `source.branch.name = ${bbqString(head)} AND destination.branch.name = ${bbqString(base)}`,
      pagelen: "1",
    });
    const rows = await this.values<RawPullRequest>(`/pullrequests?${params}`);
    const first = rows?.[0];
    return first ? this.map(first) : null;
  }

  /** Bitbucket's update requires the title alongside, so the current one rides along. */
  async describe(number: number, body: string): Promise<void> {
    const current = await this.json<RawPullRequest>(this.prPath(number));
    if (!current) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket pull request #${number} not found in ${this.repo.path}`,
      });
    }
    await this.call(this.prPath(number), {
      method: "PUT",
      body: { title: current.title ?? "", description: body },
    });
  }

  /**
   * Bitbucket merges asynchronously when the repository is large: a 202 with
   * nothing merged yet. The pull request itself is then polled until it
   * leaves OPEN, bounded, so the caller gets a settled answer either way.
   */
  async merge(number: number, params: MergeParams = {}): Promise<MergeOutcome> {
    const message = [params.commitTitle, params.commitMessage]
      .filter(Boolean)
      .join("\n\n");
    let res: Response;
    try {
      res = await bitbucketFetch(
        `${this.repoBase}${this.prPath(number)}/merge`,
        await this.token(),
        {
          method: "POST",
          body: {
            type: "pullrequest",
            merge_strategy:
              params.strategy === "squash" ? "squash" : "merge_commit",
            close_source_branch: false,
            ...(message ? { message } : {}),
          },
        },
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const rateLimited =
        cause instanceof GitProviderError && cause.isRateLimited;
      return {
        merged: false,
        reason: rateLimited ? "rate_limited" : "error",
        detail,
      };
    }
    if (res.status === 202) {
      await res.body?.cancel().catch(() => {});
      return this.awaitAsyncMerge(number);
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { merged: true };
    }
    const failure = await bitbucketFailure(res);
    return {
      merged: false,
      reason: await this.classifyRefusal(number, res.status, failure.message),
      detail: failure.message,
    };
  }

  private async awaitAsyncMerge(number: number): Promise<MergeOutcome> {
    try {
      const state = await retry(
        async () => {
          const pr = await this.read(number);
          if (!pr) {
            throw new GitProviderError({
              provider: "bitbucket",
              status: 404,
              message: `Bitbucket pull request #${number} vanished while merging`,
            });
          }
          if (pr.state === "open") {
            throw new GitProviderError({
              provider: "bitbucket",
              status: 202,
              message: "merge still in progress",
            });
          }
          return pr.state;
        },
        {
          maxAttempts: 6,
          minTimeout: 500,
          maxTimeout: 4_000,
          jitter: 0.5,
          isRetriable: (err) =>
            err instanceof GitProviderError && err.status === 202,
        },
      );
      return state === "merged"
        ? { merged: true }
        : {
            merged: false,
            reason: "blocked",
            detail: `Bitbucket left pull request #${number} ${state}`,
          };
    } catch (err) {
      const cause = err instanceof RetryError ? err.cause : err;
      if (cause instanceof GitProviderError && cause.status === 202) {
        return {
          merged: false,
          reason: "error",
          detail: `Bitbucket is still merging pull request #${number}; check again shortly`,
        };
      }
      if (cause instanceof GitProviderError && cause.status === 404) {
        return { merged: false, reason: "not_found", detail: cause.message };
      }
      return {
        merged: false,
        reason: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  /**
   * When the status and prose alone are not conclusive the pull request's
   * diffstat answers whether the branch applies — one extra call, only on the
   * refusal path. Everything else a merge can be refused for (a required
   * approval, an unresolved task, a failed build, a branch restriction) needs a
   * person.
   */
  private async classifyRefusal(
    number: number,
    status: number,
    message: string,
  ): Promise<MergeRefusal> {
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    if (isConflictRefusal(message)) return "conflict";
    const entries = await this.values<RawDiffstatEntry>(
      `${this.prPath(number)}/diffstat?pagelen=${PAGE_SIZE}`,
    ).catch(() => null);
    return conflictFromDiffstat(entries) === true ? "conflict" : "blocked";
  }

  /**
   * A commit status is a link and a state, never a log: Bitbucket publishes
   * build output only through the system that ran it (its own Pipelines, or
   * whatever posted the status). Nothing to read here.
   */
  async readCheckLog(_checkId: string): Promise<string | null> {
    return null;
  }

  /**
   * Bitbucket deployments and environments carry no published URL — an
   * environment is a name and a type, not an address — so a deploy's URL only
   * ever reaches the pull request as a commit status or a bot comment, both of
   * which the detailed read already carries.
   */
  async readDeployedUrl(_sha: string): Promise<string | null> {
    return null;
  }
}
