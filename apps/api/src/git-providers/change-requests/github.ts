/**
 * `ChangeRequestClient` over GitHub — REST for the single reads and the
 * writes, GraphQL for the detailed one.
 *
 * The split is not stylistic. A review surface needs the change request, its
 * checks, its review decision and its comments at ONE instant, and REST cannot
 * do that in fewer than four calls whose answers describe four different
 * moments; GraphQL does it in one, against a quota (points/hour) that REST is
 * not competing for. Everything else is a single REST call and stays there.
 *
 * Ported from `tools/task-board/prs-get.ts` (which reached GitHub through the
 * `mcp-github` MCP server) and `tools/github/pr-state.ts`. The mapping rules
 * those two had earned — a `mergeable_state` read conservatively, GraphQL's
 * two extra check conclusions, picking the newest MERGE rather than the newest
 * update — are kept verbatim; only the transport and the vocabulary changed.
 */

import {
  changeRequestUrl,
  type RepoRef,
  splitOwnerName,
} from "@decocms/shared/git-providers";
import { githubGraphqlRequest } from "../github/graphql";
import {
  githubApiBaseUrl,
  githubFailure,
  githubFetch,
  githubJson,
} from "../github/http";
import { GitProviderError, type TokenSource } from "../types";
import {
  type ChangeRequest,
  type ChangeRequestClient,
  type ChangeRequestDetail,
  ChangeRequestExists,
  type CheckConclusion,
  type CheckRun,
  type CheckState,
  type ChecksSummary,
  type MergeOutcome,
  type MergeParams,
  type MergeRefusal,
  type MergeStrategy,
  type OpenChangeRequestParams,
  summarizeChecks,
} from "./types";

/**
 * Merge methods to try in order, stopping at the first that succeeds. `merge`
 * is first because it is GitHub's own default, so keeping it first changes
 * nothing for every repository that allows a merge commit. The fallback is the
 * whole point: a repository with "Allow merge commits" off answers `405 Merge
 * commits are not allowed on this repository`, which used to strand a card in
 * review forever, retried against the same refusal every sweep.
 */
const MERGE_LADDER: Record<MergeStrategy, readonly string[]> = {
  any: ["merge", "squash", "rebase"],
  squash: ["squash"],
};

/** Newest deployments inspected when looking for a published URL. */
const DEPLOYMENTS_SCANNED = 3;

export interface RawPullRequest {
  number?: number | null;
  html_url?: string | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  changed_files?: number | null;
  base?: { ref?: string | null } | null;
  head?: {
    ref?: string | null;
    sha?: string | null;
    repo?: { full_name?: string | null } | null;
  } | null;
  user?: { login?: string | null } | null;
}

/**
 * Whether the change request still applies to its base. Pure — unit-tested;
 * the single home for the polarity, so no two callers can disagree.
 *
 * `mergeable_state` is the field that actually arrives from some sources:
 * github-mcp's `MinimalPullRequest` has no `mergeable` at all, so reading only
 * the boolean yielded `null` for every change request ever and the conflict
 * auto-resolution it gates never fired once in production. The boolean is
 * still read first — a full REST payload carries it and it is the richer
 * signal.
 *
 * Of the `mergeable_state` values only `dirty` means conflicts; `unknown`/`""`
 * is GitHub still computing, and the rest (`blocked`, `behind`, `unstable`)
 * are for the checks and review gates to judge, not this.
 */
export function conflictFromPullRequest(
  pr: Pick<RawPullRequest, "state" | "mergeable" | "mergeable_state"> | null,
): boolean | null {
  if (!pr) return null;
  if (pr.state !== "open") return false;
  if (typeof pr.mergeable === "boolean") return !pr.mergeable;
  const state = pr.mergeable_state;
  if (typeof state !== "string" || state === "" || state === "unknown") {
    return null;
  }
  return state === "dirty";
}

/**
 * GitHub's `mergeable_state`, read as a checks summary. Pure — unit-tested.
 *
 * It exists so a sweep can tell whether head's checks are green without paying
 * for a detailed read: `mergeable_state` rides along on the single read it
 * already does, and that per-card multiplier is what held the App's rate limit
 * shut for 17 hours once.
 *
 * Only the two unambiguous values are mapped. `blocked` is deliberately NOT
 * `pending`: it also covers a missing required review, which says nothing
 * about CI, and reading it as a red check would hold a reviewer back on a
 * change request whose deploy is perfectly fine.
 */
export function checksFromMergeableState(state: unknown): ChecksSummary {
  if (state === "clean") return "passing";
  if (state === "unstable") return "failing";
  return null;
}

/** Map a REST pull request payload to the neutral shape. Pure — unit-tested. */
export function mapPullRequest(pr: RawPullRequest): ChangeRequest {
  const merged = pr.merged === true || typeof pr.merged_at === "string";
  return {
    number: pr.number ?? 0,
    url: pr.html_url ?? "",
    title: pr.title ?? "",
    body: pr.body ?? "",
    state: merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    draft: pr.draft === true,
    mergedAt: pr.merged_at ?? null,
    base: pr.base?.ref ?? "main",
    head: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    headRepoPath: pr.head?.repo?.full_name ?? null,
    author: pr.user?.login ?? "",
    conflicting: conflictFromPullRequest(pr),
    checks: checksFromMergeableState(pr.mergeable_state),
    changedFiles:
      typeof pr.changed_files === "number" ? pr.changed_files : null,
  };
}

/** GraphQL's status enum is wider than the three states a reader is shown. */
function mapCheckState(raw: string | null | undefined): CheckState {
  if (raw === "IN_PROGRESS") return "running";
  if (raw === "COMPLETED") return "completed";
  return "queued";
}

/**
 * GraphQL carries two conclusions REST's vocabulary has no word for.
 * `STARTUP_FAILURE` is a failure by any reading; `STALE` is a run superseded
 * before it concluded, which is informational — neither may leak through as an
 * unhandled string.
 */
function mapCheckConclusion(
  raw: string | null | undefined,
): CheckConclusion | null {
  switch (raw) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "STARTUP_FAILURE":
      return "failure";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "TIMED_OUT":
      return "timed_out";
    case "ACTION_REQUIRED":
      return "action_required";
    default:
      return null;
  }
}

/**
 * The fields the detailed read needs beyond {@link ChangeRequest}. Written as
 * a fragment so the by-number and by-branch queries cannot drift.
 */
const DETAIL_FRAGMENT = `
fragment CrDetail on PullRequest {
  number
  title
  body
  state
  merged
  mergedAt
  isDraft
  mergeable
  reviewDecision
  changedFiles
  url
  baseRefName
  headRefName
  headRefOid
  headRepository { nameWithOwner }
  author { login }
  reviewThreads(first: 100) { nodes { isResolved } }
  comments(last: 50) {
    nodes { databaseId author { login } body createdAt updatedAt url }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                databaseId
                name
                status
                conclusion
                detailsUrl
                startedAt
                completedAt
                summary
              }
              ... on StatusContext {
                context
                state
                targetUrl
                description
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Matched by `headRefName`, not by walking `repository.ref(...)`: a ref deleted
 * after its merge makes the ref walk answer null, losing a merged change
 * request the panel still shows.
 */
const BY_BRANCH_QUERY = `
query CrByBranch($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      headRefName: $branch
      first: 1
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) { nodes { ...CrDetail } }
  }
}${DETAIL_FRAGMENT}`;

const BY_NUMBER_QUERY = `
query CrByNumber($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { ...CrDetail }
  }
}${DETAIL_FRAGMENT}`;

/**
 * `states: MERGED` is why this is exact. REST can only filter `state: closed`,
 * which interleaves change requests closed WITHOUT merging, so it takes a page
 * to answer and still reports "never published" for a base whose whole page
 * was abandoned.
 *
 * `PullRequestOrder` has no `MERGED_AT` field, only `UPDATED_AT` — and a
 * comment on an OLDER merged one bumps its `updatedAt` past a more recently
 * merged one, so the top node is not reliably the last publish. A window of 20
 * is pulled and {@link pickMostRecentlyMerged} picks the max `mergedAt` within
 * it rather than trusting position.
 */
const LAST_MERGED_QUERY = `
query CrLastMerged($owner: String!, $repo: String!, $base: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      states: MERGED
      baseRefName: $base
      first: 20
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number title body mergedAt url
        baseRefName headRefName headRefOid
        author { login }
      }
    }
  }
}`;

interface RawGraphqlCheck {
  __typename?: string | null;
  databaseId?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  summary?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  description?: string | null;
}

export interface RawGraphqlChangeRequest {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  merged?: boolean | null;
  mergedAt?: string | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  reviewDecision?: string | null;
  changedFiles?: number | null;
  url?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  headRepository?: { nameWithOwner?: string | null } | null;
  author?: { login?: string | null } | null;
  reviewThreads?: {
    nodes?: Array<{ isResolved?: boolean | null } | null> | null;
  } | null;
  comments?: {
    nodes?: Array<{
      databaseId?: number | null;
      author?: { login?: string | null } | null;
      body?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      url?: string | null;
    } | null> | null;
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: Array<RawGraphqlCheck | null> | null } | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
}

/** A legacy commit status, mapped to the same two fields a run has. */
function mapStatusContext(node: RawGraphqlCheck): CheckRun {
  const state = node.state;
  return {
    id: null,
    name: node.context ?? "",
    state:
      state === "PENDING" || state === "EXPECTED" ? "running" : "completed",
    conclusion:
      state === "SUCCESS"
        ? "success"
        : state === "FAILURE" || state === "ERROR"
          ? "failure"
          : state === "PENDING" || state === "EXPECTED"
            ? null
            : "neutral",
    url: node.targetUrl ?? null,
    durationMs: null,
    summary: node.description ?? null,
  };
}

/**
 * The rollup carries both check runs and legacy commit statuses, and a
 * repository can post to either — a deco site whose combined status is empty
 * but whose "Deco / QA" check run failed, and a Cloudflare deploy that is only
 * ever a status. Both are runs here, which is what collapsed the two separate
 * status/check-runs reads the MCP path made into one.
 */
export function mapChecks(pr: RawGraphqlChangeRequest): CheckRun[] {
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const runs: CheckRun[] = [];
  for (const node of contexts) {
    if (!node) continue;
    if (node.__typename === "StatusContext") {
      runs.push(mapStatusContext(node));
      continue;
    }
    if (node.__typename !== "CheckRun") continue;
    const startedAt = node.startedAt;
    const completedAt = node.completedAt;
    runs.push({
      id: node.databaseId == null ? null : String(node.databaseId),
      name: node.name ?? "",
      state: mapCheckState(node.status),
      conclusion: mapCheckConclusion(node.conclusion),
      url: node.detailsUrl ?? null,
      durationMs:
        startedAt && completedAt
          ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
          : null,
      summary: node.summary ?? null,
    });
  }
  return runs;
}

/** Fold a GraphQL node into the detailed shape. Pure — unit-tested. */
export function mapDetail(
  pr: RawGraphqlChangeRequest,
  repo: RepoRef,
): ChangeRequestDetail {
  const unresolvedConversations = (pr.reviewThreads?.nodes ?? []).filter(
    (thread) => thread?.isResolved === false,
  ).length;
  const decision = pr.reviewDecision;
  const reviewBlocked =
    decision === "REVIEW_REQUIRED" || decision === "CHANGES_REQUESTED";
  const checkRuns = mapChecks(pr);
  const number = pr.number ?? 0;
  const merged = pr.merged === true;
  return {
    number,
    url: pr.url ?? changeRequestUrl(repo, number),
    title: pr.title ?? "",
    body: pr.body ?? "",
    state: merged ? "merged" : pr.state === "OPEN" ? "open" : "closed",
    draft: pr.isDraft === true,
    mergedAt: pr.mergedAt ?? null,
    base: pr.baseRefName ?? "main",
    head: pr.headRefName ?? "",
    headSha: pr.headRefOid ?? "",
    headRepoPath: pr.headRepository?.nameWithOwner ?? null,
    author: pr.author?.login ?? "",
    // GraphQL states mergeability directly; there is no `mergeable_state` here.
    conflicting:
      pr.state !== "OPEN"
        ? false
        : pr.mergeable === "CONFLICTING"
          ? true
          : pr.mergeable === "MERGEABLE"
            ? false
            : null,
    checks: summarizeChecks(checkRuns),
    changedFiles: pr.changedFiles ?? null,
    checkRuns,
    comments: (pr.comments?.nodes ?? []).flatMap((comment) =>
      comment
        ? [
            {
              id: String(comment.databaseId ?? 0),
              author: comment.author?.login ?? "",
              body: comment.body ?? "",
              createdAt: comment.createdAt ?? "",
              updatedAt: comment.updatedAt ?? comment.createdAt ?? "",
              url: comment.url ?? "",
            },
          ]
        : [],
    ),
    unresolvedConversations,
    reviewBlocked,
  };
}

interface RawMergedNode {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  mergedAt?: string | null;
  url?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  author?: { login?: string | null } | null;
}

/**
 * Pick the actually-most-recently-merged node from a page ordered by
 * `updatedAt` — the two diverge whenever an older merged change request was
 * touched (a comment, a label) more recently than a newer merge landed.
 */
export function pickMostRecentlyMerged(
  nodes: Array<RawMergedNode | null> | null | undefined,
): RawMergedNode | null {
  let best: RawMergedNode | null = null;
  let bestMergedAt = -Infinity;
  for (const node of nodes ?? []) {
    if (!node?.mergedAt) continue;
    const mergedAt = Date.parse(node.mergedAt);
    if (Number.isNaN(mergedAt) || mergedAt <= bestMergedAt) continue;
    best = node;
    bestMergedAt = mergedAt;
  }
  return best;
}

/**
 * True when a refusal is GitHub rejecting THIS merge method — the one refusal
 * a different method can fix, so the ladder advances on it. Every other
 * refusal (branch protection, a required review, a conflict) is
 * method-independent. Pure — unit-tested.
 */
export function isMergeMethodNotAllowed(message: string): boolean {
  return /not allowed on this repository/i.test(message);
}

export class GithubChangeRequestClient implements ChangeRequestClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly apiBaseUrl: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.apiBaseUrl = githubApiBaseUrl(params.repo.host);
    const { owner, name } = splitOwnerName(params.repo);
    this.owner = owner;
    this.name = name;
  }

  private async token(force?: boolean): Promise<string | null> {
    const issued = await this.tokenSource.get(
      force ? { forceRefresh: true } : undefined,
    );
    return issued?.token ?? null;
  }

  private async requireToken(): Promise<string> {
    const token = await this.token();
    if (token) return token;
    throw new GitProviderError({
      provider: "github",
      status: 401,
      message: `No usable GitHub token for ${this.repo.path}; reconnect the account`,
    });
  }

  private get base(): string {
    return `${this.apiBaseUrl}/repos/${this.owner}/${this.name}`;
  }

  /** One REST call. 404 answers null; every other non-2xx throws. */
  private async rest<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PATCH" | "PUT";
      body?: unknown;
      operation: string;
    },
  ): Promise<T | null> {
    const res = await githubFetch(`${this.base}${path}`, {
      method: init.method,
      body: init.body,
      token: await this.requireToken(),
      operation: init.operation,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await githubFailure(res, init.operation);
    if (res.status === 204) return null;
    return githubJson<T>(res, init.operation);
  }

  private graphql<T>(args: {
    query: string;
    variables: Record<string, unknown>;
    label: string;
    operation: string;
  }): Promise<T> {
    return githubGraphqlRequest<T>({
      getToken: (force) => this.token(force),
      missingTokenMessage: `No usable GitHub token for ${this.repo.path}; reconnect the account`,
      ...args,
    });
  }

  async read(number: number): Promise<ChangeRequest | null> {
    const pr = await this.rest<RawPullRequest>(`/pulls/${number}`, {
      operation: "change_request_read",
    });
    return pr ? mapPullRequest(pr) : null;
  }

  async readForBranch(branch: string): Promise<ChangeRequest | null> {
    return await this.readDetailed({ branch });
  }

  async readDetailed(
    target: { number: number } | { branch: string },
  ): Promise<ChangeRequestDetail | null> {
    const byNumber = "number" in target;
    const payload = await this.graphql<{
      repository?: {
        pullRequest?: RawGraphqlChangeRequest | null;
        pullRequests?: {
          nodes?: Array<RawGraphqlChangeRequest | null> | null;
        } | null;
      } | null;
    }>({
      query: byNumber ? BY_NUMBER_QUERY : BY_BRANCH_QUERY,
      variables: byNumber
        ? { owner: this.owner, repo: this.name, number: target.number }
        : { owner: this.owner, repo: this.name, branch: target.branch },
      label: `change request for ${this.repo.path}`,
      operation: "change_request_detail",
    });
    const repository = payload.repository;
    if (!repository) {
      throw new GitProviderError({
        provider: "github",
        status: 404,
        message: `${this.repo.path} is not accessible with this credential`,
      });
    }
    const node = byNumber
      ? repository.pullRequest
      : repository.pullRequests?.nodes?.[0];
    return node ? mapDetail(node, this.repo) : null;
  }

  async listOpen(limit: number): Promise<ChangeRequest[]> {
    const rows = await this.rest<RawPullRequest[]>(
      `/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(limit, 100)}`,
      { operation: "change_request_list" },
    );
    return (rows ?? []).map(mapPullRequest);
  }

  async lastMergedInto(base: string): Promise<ChangeRequest | null> {
    const payload = await this.graphql<{
      repository?: {
        pullRequests?: { nodes?: Array<RawMergedNode | null> | null } | null;
      } | null;
    }>({
      query: LAST_MERGED_QUERY,
      variables: { owner: this.owner, repo: this.name, base },
      label: `last merged into ${base} on ${this.repo.path}`,
      operation: "change_request_last_merged",
    });
    if (!payload.repository) {
      throw new GitProviderError({
        provider: "github",
        status: 404,
        message: `${this.repo.path} is not accessible with this credential`,
      });
    }
    const node = pickMostRecentlyMerged(payload.repository.pullRequests?.nodes);
    if (!node) return null;
    const number = node.number ?? 0;
    return {
      number,
      url: node.url ?? changeRequestUrl(this.repo, number),
      title: node.title ?? "",
      body: node.body ?? "",
      state: "merged",
      draft: false,
      mergedAt: node.mergedAt ?? null,
      base: node.baseRefName ?? base,
      head: node.headRefName ?? "",
      headSha: node.headRefOid ?? "",
      headRepoPath: null,
      author: node.author?.login ?? "",
      conflicting: false,
      checks: null,
      changedFiles: null,
    };
  }

  async open(params: OpenChangeRequestParams): Promise<ChangeRequest> {
    const res = await githubFetch(`${this.base}/pulls`, {
      method: "POST",
      token: await this.requireToken(),
      operation: "change_request_open",
      body: {
        title: params.title,
        body: params.body || undefined,
        head: params.head,
        base: params.base,
      },
    });
    if (res.ok) {
      return mapPullRequest(
        await githubJson<RawPullRequest>(res, "change_request_open"),
      );
    }
    const failure = await githubFailure(res, "change_request_open");
    if (/already exists|pull request already/i.test(failure.message)) {
      throw new ChangeRequestExists(
        failure.message,
        await this.readForBranch(params.head).catch(() => null),
      );
    }
    throw failure;
  }

  async describe(number: number, body: string): Promise<void> {
    await this.rest(`/pulls/${number}`, {
      method: "PATCH",
      body: { body },
      operation: "change_request_describe",
    });
  }

  async merge(number: number, params: MergeParams = {}): Promise<MergeOutcome> {
    const methods = MERGE_LADDER[params.strategy ?? "any"];
    let lastRefusal = "";
    for (const method of methods) {
      const attempt = await this.attemptMerge(number, method, params);
      if (attempt.merged) return attempt;
      // The repository forbids THIS method — remember it and try the next.
      if (
        attempt.reason === "blocked" &&
        isMergeMethodNotAllowed(attempt.detail)
      ) {
        lastRefusal = attempt.detail;
        continue;
      }
      return attempt;
    }
    return { merged: false, reason: "blocked", detail: lastRefusal };
  }

  /**
   * One merge round-trip, classified. A refusal costs one extra read to ask
   * whether the branch conflicts, because GitHub answers `405 Pull Request is
   * not mergeable` for a conflict and for a policy block alike — and the two
   * lead to completely different reactions (hand it back to the author to
   * rebase, versus hand it to a person). The read is only ever paid on the
   * refusal path, never on a rate limit.
   */
  private async attemptMerge(
    number: number,
    method: string,
    params: MergeParams,
  ): Promise<MergeOutcome> {
    let res: Response;
    try {
      res = await githubFetch(`${this.base}/pulls/${number}/merge`, {
        method: "PUT",
        token: await this.requireToken(),
        operation: "change_request_merge",
        body: {
          merge_method: method,
          ...(params.commitTitle ? { commit_title: params.commitTitle } : {}),
          ...(params.commitMessage
            ? { commit_message: params.commitMessage }
            : {}),
        },
      });
    } catch (cause) {
      return { merged: false, ...classifyThrown(cause) };
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { merged: true };
    }
    const failure = await githubFailure(res, "change_request_merge");
    if (res.status === 404) {
      return { merged: false, reason: "not_found", detail: failure.message };
    }
    if (isMergeMethodNotAllowed(failure.message)) {
      return { merged: false, reason: "blocked", detail: failure.message };
    }
    const conflicting = await this.read(number)
      .then((cr) => cr?.conflicting ?? null)
      .catch(() => null);
    return {
      merged: false,
      reason: conflicting === true ? "conflict" : "blocked",
      detail: failure.message,
    };
  }

  async readCheckLog(checkId: string): Promise<string | null> {
    const run = await this.rest<{
      output?: { summary?: string | null; text?: string | null } | null;
    }>(`/check-runs/${encodeURIComponent(checkId)}`, {
      operation: "change_request_check_log",
    });
    return run?.output?.summary ?? run?.output?.text ?? null;
  }

  async readDeployedUrl(sha: string): Promise<string | null> {
    const deployments = await this.rest<Array<{ id?: number }>>(
      `/deployments?sha=${encodeURIComponent(sha)}&per_page=${DEPLOYMENTS_SCANNED}`,
      { operation: "change_request_deployments" },
    );
    for (const deployment of deployments ?? []) {
      if (typeof deployment.id !== "number") continue;
      const statuses = await this.rest<
        Array<{ state?: string; environment_url?: string | null }>
      >(`/deployments/${deployment.id}/statuses?per_page=10`, {
        operation: "change_request_deployment_statuses",
      });
      const published = (statuses ?? []).find(
        (status) =>
          status.state === "success" &&
          typeof status.environment_url === "string" &&
          status.environment_url.length > 0,
      );
      if (published?.environment_url) return published.environment_url;
    }
    return null;
  }
}

/** A thrown transport/rate failure, as a merge outcome. */
function classifyThrown(cause: unknown): {
  reason: MergeRefusal;
  detail: string;
} {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof GitProviderError && cause.isRateLimited) {
    return { reason: "rate_limited", detail };
  }
  return { reason: "error", detail };
}
