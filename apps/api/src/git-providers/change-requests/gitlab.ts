/**
 * `ChangeRequestClient` over GitLab's REST v4 API.
 *
 * A merge request is the same object a pull request is, so the read side maps
 * almost field-for-field. The two places GitLab needs more work than GitHub
 * are the detailed read — GitLab has no GraphQL-shaped "everything at once",
 * so the notes, the discussions and the pipeline's jobs are three more calls —
 * and the merge refusal, whose meaning has to be recovered from the merge
 * request's own state because GitLab's 405 body says only "Method Not
 * Allowed".
 *
 * GitLab answers a richer CI signal than GitHub for free: `head_pipeline`
 * rides along on the single merge-request read, so the cheap `checks` here is
 * the real pipeline status rather than the conservative guess GitHub's
 * `mergeable_state` forces.
 */

import { changeRequestUrl, type RepoRef } from "@decocms/shared/git-providers";
import { encodeProjectPath } from "../gitlab/client";
import { gitlabApiBaseUrl, gitlabFailure, gitlabFetch } from "../gitlab/http";
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
  type ChecksSummary,
  type MergeOutcome,
  type MergeParams,
  type MergeRefusal,
  type OpenChangeRequestParams,
  summarizeChecks,
} from "./types";

/** One page is the whole answer here — the same bound GitHub's rollup uses. */
const PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 50;
/** Newest deployments scanned when looking for a published environment URL. */
const DEPLOYMENTS_SCANNED = 30;
/**
 * A job trace is the whole build log and can be megabytes. Only its tail says
 * why the job failed, which is what a reader expanding the row is after.
 */
const TRACE_TAIL_BYTES = 8_000;

export interface RawMergeRequest {
  iid?: number | null;
  web_url?: string | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  draft?: boolean | null;
  work_in_progress?: boolean | null;
  merged_at?: string | null;
  target_branch?: string | null;
  source_branch?: string | null;
  sha?: string | null;
  project_id?: number | null;
  source_project_id?: number | null;
  author?: { username?: string | null } | null;
  has_conflicts?: boolean | null;
  merge_status?: string | null;
  detailed_merge_status?: string | null;
  changes_count?: string | number | null;
  blocking_discussions_resolved?: boolean | null;
  head_pipeline?: { id?: number | null; status?: string | null } | null;
  pipeline?: { id?: number | null; status?: string | null } | null;
}

/** GitLab's four lifecycle values, in the neutral vocabulary. */
export function mapState(state: unknown): ChangeRequest["state"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  // `locked` is a transient state of an OPEN merge request being merged.
  return "open";
}

/**
 * Whether the merge request still applies to its target. Pure — unit-tested.
 *
 * `has_conflicts` is authoritative when GitLab has set it. Otherwise
 * `detailed_merge_status` (GitLab 15.6+) names the blocker precisely, and only
 * one of its values is a conflict; `merge_status` is the older, coarser field
 * kept as the last resort. `checking`/`unchecked` mean GitLab has not worked
 * it out yet — and an unknown must never read as a conflict.
 */
export function conflictFromMergeRequest(
  mr: Pick<
    RawMergeRequest,
    "state" | "has_conflicts" | "merge_status" | "detailed_merge_status"
  > | null,
): boolean | null {
  if (!mr) return null;
  if (mapState(mr.state) !== "open") return false;
  if (typeof mr.has_conflicts === "boolean") return mr.has_conflicts;
  const detailed = mr.detailed_merge_status;
  if (detailed === "conflict" || detailed === "broken_status") return true;
  if (detailed === "mergeable") return false;
  if (mr.merge_status === "can_be_merged") return false;
  if (mr.merge_status === "cannot_be_merged") return true;
  return null;
}

/**
 * A pipeline status, as a checks summary. Pure — unit-tested.
 *
 * `canceled` reads as failing on purpose, matching the check-run conclusions
 * the GitHub side treats as red: a run that did not finish is not evidence the
 * head is good. `skipped` and `manual` say nothing at all.
 */
export function checksFromPipelineStatus(status: unknown): ChecksSummary {
  switch (status) {
    case "success":
      return "passing";
    case "failed":
    case "canceled":
      return "failing";
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "running":
    case "scheduled":
      return "pending";
    default:
      return null;
  }
}

/** GitLab's job status, split into the state/conclusion pair a reader sees. */
export function mapJobStatus(status: unknown): {
  state: CheckState;
  conclusion: CheckConclusion | null;
} {
  switch (status) {
    case "success":
      return { state: "completed", conclusion: "success" };
    case "failed":
      return { state: "completed", conclusion: "failure" };
    case "canceled":
      return { state: "completed", conclusion: "cancelled" };
    case "skipped":
      return { state: "completed", conclusion: "skipped" };
    case "manual":
      return { state: "completed", conclusion: "action_required" };
    case "running":
      return { state: "running", conclusion: null };
    default:
      return { state: "queued", conclusion: null };
  }
}

/** `changes_count` is a string, and "1000+" past GitLab's counting limit. */
export function parseChangesCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

interface RawJob {
  id?: number | null;
  name?: string | null;
  status?: string | null;
  web_url?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  stage?: string | null;
}

export function mapJob(job: RawJob): CheckRun {
  const { state, conclusion } = mapJobStatus(job.status);
  const started = job.started_at ? Date.parse(job.started_at) : NaN;
  const finished = job.finished_at ? Date.parse(job.finished_at) : NaN;
  return {
    id: job.id == null ? null : String(job.id),
    name: job.name ?? "",
    state,
    conclusion,
    url: job.web_url ?? null,
    durationMs:
      Number.isFinite(started) && Number.isFinite(finished)
        ? finished - started
        : null,
    // A job's report is its trace, which is far too big to carry in a listing.
    summary: null,
  };
}

interface RawNote {
  id?: number | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  system?: boolean | null;
  author?: { username?: string | null } | null;
}

/**
 * GitLab records its own activity ("changed the description", "assigned to")
 * as notes with `system: true`. They are not comments, and counting them as
 * such is what would make a bot's preview link compete with "added 1 commit".
 */
export function mapNotes(
  notes: RawNote[],
  crUrl: string,
): ChangeRequestComment[] {
  return notes
    .filter((note) => note.system !== true && typeof note.body === "string")
    .map((note) => ({
      id: String(note.id ?? 0),
      author: note.author?.username ?? "",
      body: note.body ?? "",
      createdAt: note.created_at ?? "",
      updatedAt: note.updated_at ?? note.created_at ?? "",
      url: note.id == null ? crUrl : `${crUrl}#note_${note.id}`,
    }));
}

interface RawDiscussion {
  notes?: Array<{ resolvable?: boolean | null; resolved?: boolean | null }>;
}

/**
 * A discussion is unresolved when it CAN be resolved and no note in it has
 * been. GitLab marks resolution per note, so the thread is the unit only after
 * folding them.
 */
export function countUnresolved(discussions: RawDiscussion[]): number {
  let count = 0;
  for (const discussion of discussions) {
    const notes = discussion.notes ?? [];
    const resolvable = notes.filter((note) => note.resolvable === true);
    if (resolvable.length === 0) continue;
    if (resolvable.some((note) => note.resolved !== true)) count += 1;
  }
  return count;
}

/**
 * True when a merge refusal is GitLab saying the branch does not apply. Pure —
 * unit-tested. GitLab is explicit here where GitHub is not, which is why the
 * GitLab side can classify without a second read in the common case.
 */
export function isConflictRefusal(status: number, message: string): boolean {
  if (status === 406) return true;
  return /conflict|cannot be merged/i.test(message);
}

export class GitlabChangeRequestClient implements ChangeRequestClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly apiBase: string;
  private readonly projectBase: string;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.tokenSource = params.tokenSource;
    this.apiBase = gitlabApiBaseUrl(params.repo.host);
    this.projectBase = `/projects/${encodeProjectPath(params.repo.path)}`;
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

  /** One REST call under the project. 404 answers null; other non-2xx throws. */
  private async call(
    pathAndQuery: string,
    init: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      accept?: string;
    } = {},
  ): Promise<Response | null> {
    const res = await gitlabFetch(
      `${this.apiBase}${this.projectBase}${pathAndQuery}`,
      await this.token(),
      init,
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await gitlabFailure(res);
    return res;
  }

  private async json<T>(
    pathAndQuery: string,
    init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T | null> {
    const res = await this.call(pathAndQuery, init);
    return res === null ? null : ((await res.json()) as T);
  }

  private mrPath(iid: number): string {
    return `/merge_requests/${iid}`;
  }

  private map(mr: RawMergeRequest): ChangeRequest {
    const iid = mr.iid ?? 0;
    const sameProject =
      mr.source_project_id == null ||
      mr.project_id == null ||
      mr.source_project_id === mr.project_id;
    return {
      number: iid,
      url: mr.web_url ?? changeRequestUrl(this.repo, iid),
      title: mr.title ?? "",
      body: mr.description ?? "",
      state: mapState(mr.state),
      draft: mr.draft === true || mr.work_in_progress === true,
      mergedAt: mr.merged_at ?? null,
      base: mr.target_branch ?? "main",
      head: mr.source_branch ?? "",
      headSha: mr.sha ?? "",
      // A fork's path is not on the payload; null already means "not local".
      headRepoPath: sameProject ? this.repo.path : null,
      author: mr.author?.username ?? "",
      conflicting: conflictFromMergeRequest(mr),
      checks: checksFromPipelineStatus(
        (mr.head_pipeline ?? mr.pipeline)?.status,
      ),
      changedFiles: parseChangesCount(mr.changes_count),
    };
  }

  async read(number: number): Promise<ChangeRequest | null> {
    const mr = await this.json<RawMergeRequest>(this.mrPath(number));
    return mr ? this.map(mr) : null;
  }

  async readForBranch(branch: string): Promise<ChangeRequest | null> {
    const rows = await this.json<RawMergeRequest[]>(
      `/merge_requests?source_branch=${encodeURIComponent(branch)}` +
        `&state=all&order_by=updated_at&sort=desc&per_page=1`,
    );
    const newest = rows?.[0];
    return newest ? this.map(newest) : null;
  }

  async readDetailed(
    target: { number: number } | { branch: string },
  ): Promise<ChangeRequestDetail | null> {
    /**
     * The by-branch path costs one extra call: the merge-request LISTING
     * carries no `head_pipeline`, so the number it resolves is then read on
     * its own. Reading the merge request itself is what makes the CI half of
     * this answer possible at all.
     */
    const iid =
      "number" in target
        ? target.number
        : ((await this.readForBranch(target.branch))?.number ?? null);
    if (iid === null) return null;
    const mr = await this.json<RawMergeRequest>(this.mrPath(iid));
    if (!mr) return null;
    const base = this.map(mr);
    const pipelineId = (mr.head_pipeline ?? mr.pipeline)?.id ?? null;

    const [notes, discussions, jobs] = await Promise.all([
      this.json<RawNote[]>(
        `${this.mrPath(iid)}/notes` +
          `?sort=desc&order_by=created_at&per_page=${COMMENT_PAGE_SIZE}`,
      ),
      this.json<RawDiscussion[]>(
        `${this.mrPath(iid)}/discussions?per_page=${PAGE_SIZE}`,
      ),
      pipelineId === null
        ? Promise.resolve(null)
        : this.json<RawJob[]>(
            `/pipelines/${pipelineId}/jobs?per_page=${PAGE_SIZE}`,
          ),
    ]);

    const checkRuns = (jobs ?? []).map(mapJob);
    const unresolvedConversations = countUnresolved(discussions ?? []);
    return {
      ...base,
      /**
       * The per-job reduction wins over the pipeline's own status when there
       * are jobs: they are the same fact at different resolutions, and
       * agreeing with the GitHub side's reducer matters more than agreeing
       * with GitLab's rollup.
       */
      checks: checkRuns.length > 0 ? summarizeChecks(checkRuns) : base.checks,
      checkRuns,
      comments: mapNotes(notes ?? [], base.url).reverse(),
      unresolvedConversations,
      /**
       * GitLab reports what is left to do rather than a review decision.
       * `not_approved` is the approval rule (a paid feature, absent on many
       * instances); an unresolved blocking discussion is the free equivalent
       * of "someone asked for changes".
       */
      reviewBlocked:
        mr.detailed_merge_status === "not_approved" ||
        mr.blocking_discussions_resolved === false,
    };
  }

  async listOpen(limit: number): Promise<ChangeRequest[]> {
    const rows = await this.json<RawMergeRequest[]>(
      `/merge_requests?state=opened&order_by=updated_at&sort=desc` +
        `&per_page=${Math.min(limit, PAGE_SIZE)}`,
    );
    return (rows ?? []).map((mr) => this.map(mr));
  }

  async lastMergedInto(base: string): Promise<ChangeRequest | null> {
    const rows = await this.json<RawMergeRequest[]>(
      `/merge_requests?state=merged&target_branch=${encodeURIComponent(base)}` +
        `&order_by=updated_at&sort=desc&per_page=20`,
    );
    // Same reason as the GitHub side: ordered by last touch, not by merge.
    let best: RawMergeRequest | null = null;
    let bestAt = -Infinity;
    for (const mr of rows ?? []) {
      const at = mr.merged_at ? Date.parse(mr.merged_at) : NaN;
      if (Number.isNaN(at) || at <= bestAt) continue;
      best = mr;
      bestAt = at;
    }
    return best ? this.map(best) : null;
  }

  async open(params: OpenChangeRequestParams): Promise<ChangeRequest> {
    const res = await gitlabFetch(
      `${this.apiBase}${this.projectBase}/merge_requests`,
      await this.token(),
      {
        method: "POST",
        body: {
          source_branch: params.head,
          target_branch: params.base,
          title: params.title,
          description: params.body || undefined,
        },
      },
    );
    if (res.ok) return this.map((await res.json()) as RawMergeRequest);
    const failure = await gitlabFailure(res);
    if (/already exists/i.test(failure.message)) {
      throw new ChangeRequestExists(
        failure.message,
        await this.readForBranch(params.head).catch(() => null),
      );
    }
    throw failure;
  }

  async describe(number: number, body: string): Promise<void> {
    await this.call(this.mrPath(number), {
      method: "PUT",
      body: { description: body },
    });
  }

  async merge(number: number, params: MergeParams = {}): Promise<MergeOutcome> {
    const squash = params.strategy === "squash";
    let res: Response;
    try {
      res = await gitlabFetch(
        `${this.apiBase}${this.projectBase}${this.mrPath(number)}/merge`,
        await this.token(),
        {
          method: "PUT",
          body: {
            squash,
            ...(params.commitTitle || params.commitMessage
              ? {
                  [squash ? "squash_commit_message" : "merge_commit_message"]: [
                    params.commitTitle,
                    params.commitMessage,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                }
              : {}),
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
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { merged: true };
    }
    const failure = await gitlabFailure(res);
    return {
      merged: false,
      reason: await this.classifyRefusal(number, res.status, failure.message),
      detail: failure.message,
    };
  }

  /**
   * GitLab's 405 body says only "Method Not Allowed" — it covers a draft, a
   * conflict, an unresolved discussion and a red required pipeline alike. So
   * when the status alone is not conclusive the merge request is re-read, and
   * its own `has_conflicts`/`detailed_merge_status` answers the question. One
   * extra call, only on the refusal path.
   */
  private async classifyRefusal(
    number: number,
    status: number,
    message: string,
  ): Promise<MergeRefusal> {
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    if (isConflictRefusal(status, message)) return "conflict";
    const conflicting = await this.read(number)
      .then((cr) => cr?.conflicting ?? null)
      .catch(() => null);
    return conflicting === true ? "conflict" : "blocked";
  }

  async readCheckLog(checkId: string): Promise<string | null> {
    const res = await this.call(`/jobs/${encodeURIComponent(checkId)}/trace`, {
      accept: "text/plain",
    });
    if (res === null) return null;
    const text = await res.text();
    if (!text) return null;
    return text.length > TRACE_TAIL_BYTES
      ? text.slice(text.length - TRACE_TAIL_BYTES)
      : text;
  }

  async readDeployedUrl(sha: string): Promise<string | null> {
    const deployments = await this.json<
      Array<{
        sha?: string | null;
        status?: string | null;
        environment?: { external_url?: string | null } | null;
      }>
    >(`/deployments?order_by=id&sort=desc&per_page=${DEPLOYMENTS_SCANNED}`);
    for (const deployment of deployments ?? []) {
      if (deployment.sha !== sha) continue;
      if (deployment.status !== "success") continue;
      const url = deployment.environment?.external_url;
      if (typeof url === "string" && url.length > 0) return url;
    }
    return null;
  }
}
