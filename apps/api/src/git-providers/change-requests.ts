/**
 * Proposing, inspecting and landing a change, as an intention rather than as
 * one provider's object model.
 *
 * GitHub calls it a pull request and GitLab a merge request; both are "here is
 * a branch, please put it on that one", both are numbered per repository, and
 * both carry the same four things a reviewer acts on: a lifecycle state,
 * whether it still applies to its base, what CI said, and what people wrote.
 * That is the whole interface. Nothing here names a pull request, a check run,
 * a pipeline or a job.
 *
 * The providers disagree on how many calls each answer costs — GitHub folds a
 * detailed read into one GraphQL query, GitLab needs a handful of REST hops —
 * and deliberately so: the callers are budgeted in reads, not in round-trips,
 * which is why the cheap read and the detailed one are separate methods rather
 * than one method with a flag.
 */

import type { RepoRef } from "@decocms/shared/git-providers";

/**
 * Where the change request is in its life. `merged` is its own state, not a
 * flavour of `closed`: closed-unmerged means abandoned, and every gate that
 * advances a task apart cares which of the two happened.
 */
export type ChangeRequestState = "open" | "closed" | "merged";

/** CI, reduced to what a gate can act on. `null` = nothing said, not "green". */
export type ChecksSummary = "pending" | "passing" | "failing" | null;

export type CheckState = "queued" | "running" | "completed";

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

/**
 * One CI run attached to the head commit — a GitHub check run, a GitHub commit
 * status, or a GitLab pipeline job. `id` is null for the shapes that have no
 * addressable log (a commit status is a link, not a run).
 */
export interface CheckRun {
  id: string | null;
  name: string;
  state: CheckState;
  conclusion: CheckConclusion | null;
  /** Where a human goes to read this run. */
  url: string | null;
  durationMs: number | null;
  /**
   * The run's own report, when the provider publishes one with the listing
   * (GitHub check-run `output.summary`). Null does NOT mean there is none —
   * see `readCheckLog`, which fetches it for a single run on demand.
   */
  summary: string | null;
}

/** Conclusions that mean the run failed — the checks gate's definition of red. */
const FAILED_CONCLUSIONS = new Set<CheckConclusion>([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

/**
 * Reduce a run list to one summary, worst-first. Lives here rather than in
 * either implementation so a red build cannot mean different things on GitHub
 * and GitLab. `null` for an empty list: a change request without CI is not
 * "pending", it simply has nothing to say.
 */
export function summarizeChecks(runs: CheckRun[]): ChecksSummary {
  if (runs.length === 0) return null;
  let pending = false;
  for (const run of runs) {
    if (run.state !== "completed") {
      pending = true;
      continue;
    }
    if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) {
      return "failing";
    }
  }
  return pending ? "pending" : "passing";
}

/** A comment on the change request itself, not on a file and line. */
export interface ChangeRequestComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /**
   * When it was last edited, `createdAt` when never. Load-bearing, not
   * bookkeeping: Vercel and Cloudflare EDIT one sticky comment in place on
   * every push, so `createdAt` stays frozen at its first post and anything
   * ranking by it reads a months-old deploy link as the newest.
   */
  updatedAt: string;
  url: string;
}

/**
 * A change request as one cheap read answers it — everything that comes off
 * the provider's single "get" for it, and nothing that needs a second call.
 */
export interface ChangeRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  state: ChangeRequestState;
  draft: boolean;
  mergedAt: string | null;
  /** Branch it targets. */
  base: string;
  /** Branch it proposes. */
  head: string;
  headSha: string;
  /**
   * `namespace/name` of the repository the head branch lives in — different
   * from this repository for a fork, null when the fork is gone. Such a change
   * request cannot be checked out as a local branch.
   */
  headRepoPath: string | null;
  author: string;
  /**
   * Whether it still applies to its base. `true` = conflicts, `false` = it
   * applies, `null` = the provider has not worked it out yet (both compute
   * this asynchronously). An unknown must never be read as a conflict.
   */
  conflicting: boolean | null;
  /**
   * The CI signal that rides along on this one read. Deliberately coarse and
   * conservative: it exists so a sweep can gate on green without paying for
   * {@link ChangeRequestClient.readDetailed}, and it answers `null` whenever
   * the provider's summary field is about anything other than CI.
   */
  checks: ChecksSummary;
  /** Files touched, when the read carries it. */
  changedFiles: number | null;
}

/**
 * Everything a review surface draws. The extra fields over {@link ChangeRequest}
 * are the ones that cost the provider real work: the per-run CI list, the
 * comments, and how much human review is outstanding.
 */
export interface ChangeRequestDetail extends ChangeRequest {
  checkRuns: CheckRun[];
  comments: ChangeRequestComment[];
  /** Review conversations the provider reports as still open. */
  unresolvedConversations: number;
  /**
   * A person still has to act before this can land — a required approval is
   * missing, or someone asked for changes. Distinct from `checks`, which is
   * about machines, and from `conflicting`, which is about the branch.
   */
  reviewBlocked: boolean;
}

/**
 * How much history to leave behind. `squash` is asked for by name because a
 * publish IS one commit on the base branch; `any` means the caller does not
 * care and the implementation should use whatever the repository allows.
 */
export type MergeStrategy = "any" | "squash";

/**
 * Why a merge did not happen, in terms of who can do something about it.
 *
 * - `conflict` — the branch no longer applies; the author must rebase.
 * - `blocked` — a policy refusal (branch protection, a missing approval, an
 *   unresolved discussion, a draft). Only a person can clear it, and no other
 *   merge strategy would help.
 * - `rate_limited` — the provider is shedding load. Says nothing about
 *   mergeability, and asking again immediately IS the burst being limited.
 * - `not_found` — no such change request, or the credential cannot see it.
 * - `error` — anything else, including a transport failure.
 */
export type MergeRefusal =
  | "conflict"
  | "blocked"
  | "rate_limited"
  | "not_found"
  | "error";

export type MergeOutcome =
  | { merged: true }
  | { merged: false; reason: MergeRefusal; detail: string };

export interface OpenChangeRequestParams {
  head: string;
  base: string;
  title: string;
  body?: string;
}

export interface MergeParams {
  strategy?: MergeStrategy;
  commitTitle?: string;
  commitMessage?: string;
}

/**
 * Raised by {@link ChangeRequestClient.open} when the head branch already has
 * an open change request. The caller decides whether that is an error or the
 * answer it wanted — the publish path reuses the existing one.
 */
export class ChangeRequestExists extends Error {
  readonly existing: ChangeRequest | null;
  constructor(message: string, existing: ChangeRequest | null) {
    super(message);
    this.name = "ChangeRequestExists";
    this.existing = existing;
  }
}

export interface ChangeRequestClient {
  readonly repo: RepoRef;

  /** One change request by number, or null when there is none. */
  read(number: number): Promise<ChangeRequest | null>;

  /**
   * The newest change request proposing `branch`, open or not — a merged one
   * is what a publish surface shows after it lands, so this must not filter to
   * open. Null when the branch has never had one.
   */
  readForBranch(branch: string): Promise<ChangeRequest | null>;

  /**
   * Everything a review surface draws, by number or by head branch. Costs
   * several provider calls; {@link read} is the one to use in a sweep.
   */
  readDetailed(
    target: { number: number } | { branch: string },
  ): Promise<ChangeRequestDetail | null>;

  /** Open change requests, newest first, capped at `limit`. */
  listOpen(limit: number): Promise<ChangeRequest[]>;

  /**
   * The most recently merged change request into `base`. Ordered by when it
   * MERGED, not by when it was last touched — a comment on an older one must
   * not make it look like the latest.
   */
  lastMergedInto(base: string): Promise<ChangeRequest | null>;

  /** Propose `head` onto `base`. Throws {@link ChangeRequestExists} on a duplicate. */
  open(params: OpenChangeRequestParams): Promise<ChangeRequest>;

  /** Replace the description. Used to add a co-author trailer after the fact. */
  describe(number: number, body: string): Promise<void>;

  /**
   * Land it. Never throws for a refusal — every outcome the caller branches on
   * is a value, so a provider's prose (a 405 here, a 406 there) is classified
   * once, inside the implementation that knows its own vocabulary.
   */
  merge(number: number, params?: MergeParams): Promise<MergeOutcome>;

  /**
   * One CI run's report, for the rows a reader expands: GitHub's check-run
   * `output` markdown, GitLab's job trace. Null when the run has none.
   */
  readCheckLog(checkId: string): Promise<string | null>;

  /**
   * The URL a deploy for `sha` published, when the provider tracks deployments
   * itself (GitHub Deployments, GitLab Environments) rather than only as a
   * commit status or a bot comment. Null when there is no deployment with a
   * published URL yet.
   */
  readDeployedUrl(sha: string): Promise<string | null>;
}
