/**
 * Change-request panel data hooks. The branch's change request, its CI runs,
 * its review state and its comments all come from ONE polled read — the
 * `CHANGE_REQUEST_STATE` tool. The hooks below are selectors over that one
 * cache entry (they share `KEYS.githubPrState`), so mounting all four costs
 * one request and every surface reads the same instant of it.
 *
 * Nothing here knows which provider answered. The panel used to hold a GitHub
 * MCP client and call `list_pull_requests` and `GET_CHECK_RUN` by name, which
 * is why a GitLab project's panel had nothing to call at all; both are now
 * neutral Studio tools.
 */

import { useQuery } from "@tanstack/react-query";

import { callStudioTool } from "@/lib/studio-tools";
import {
  hasRepoCredential,
  type RepoToolTarget,
  repoTargetKey,
} from "@/lib/github-repo";
import { KEYS } from "@/lib/query-keys";
import type { CheckRunOutput } from "./check-run-output.ts";

export interface PrSummary {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  base: string;
  head: string;
  /** SHA of the head commit — used to key the diff. */
  headSha: string;
  /**
   * `owner/name` of the repository the head branch lives in. Differs from the
   * base repository for a cross-fork change request (or null when the fork was
   * deleted) — such a change request can't be opened as a local branch. Same
   * as the base repository for internal ones.
   */
  headRepoFullName: string | null;
  htmlUrl: string;
  author: string;
  /**
   * Files it touches. null when the source could not say, so a caller must not
   * read null as "no changes".
   */
  changedFiles: number | null;
}

const POLL = 60_000;
const STALE = 30_000;

/**
 * Which repository the hooks act on.
 *
 * `owner`/`repo` stay because they key the query cache and the diff reader; a
 * GitLab project in subgroups carries every namespace level in `owner`.
 * `target` is what actually identifies the repository to the server.
 */
export interface RepoArgs {
  orgId: string;
  orgSlug: string;
  target: RepoToolTarget;
  owner: string;
  repo: string;
}

export interface PrFile {
  filename: string;
  status:
    | "added"
    | "removed"
    | "modified"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  additions: number;
  deletions: number;
  blobUrl: string | null;
  /** Path before the rename, when `status === "renamed"`. */
  previousFilename: string | null;
}

export interface CheckRun {
  /** Null for a run with no addressable log (a GitHub commit status). */
  id: string | null;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  htmlUrl: string;
  durationMs: number | null;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}

type ChangeRequestState = Awaited<
  ReturnType<typeof callStudioTool<"CHANGE_REQUEST_STATE">>
>["changeRequest"];

type ChangeRequestSummary = Awaited<
  ReturnType<typeof callStudioTool<"CHANGE_REQUEST_LAST_MERGED">>
>["changeRequest"];

/**
 * The panel's view of a change request. `merged` is split back out of the
 * three-value state because the panel's own state machine is written against
 * the pair, and a merged one is drawn as closed.
 */
function toPrSummary(cr: NonNullable<ChangeRequestSummary>): PrSummary {
  return {
    number: cr.number,
    title: cr.title,
    body: cr.body,
    state: cr.state === "open" ? "open" : "closed",
    merged: cr.state === "merged",
    mergedAt: cr.mergedAt,
    base: cr.base,
    head: cr.head,
    headSha: cr.headSha,
    headRepoFullName: cr.headRepoPath,
    htmlUrl: cr.url,
    author: cr.author,
    changedFiles: cr.changedFiles,
  };
}

/** The panel's check row. `state` keeps the panel's existing three names. */
function toCheckRun(
  run: NonNullable<ChangeRequestState>["checkRuns"][number],
): CheckRun {
  return {
    id: run.id,
    name: run.name,
    status: run.state === "running" ? "in_progress" : run.state,
    conclusion: run.conclusion,
    htmlUrl: run.url ?? "",
    durationMs: run.durationMs,
  };
}

/**
 * The one read every panel hook selects from. Spread this rather than
 * restating the key — two hooks that disagree about it would double the poll.
 */
export function prStateQueryOptions(
  args: RepoArgs & { branch: string | null },
) {
  const { orgSlug, target, owner, repo, branch } = args;
  return {
    queryKey: KEYS.githubPrState(
      orgSlug,
      repoTargetKey(target),
      owner,
      repo,
      branch,
    ),
    queryFn: () =>
      callStudioTool(orgSlug, "CHANGE_REQUEST_STATE", {
        ...target,
        branch: branch as string,
      }),
    /**
     * A repository row is enough on its own — a GitLab project never has a
     * connection, so requiring one here is what would keep its panel empty.
     */
    enabled: !!branch && hasRepoCredential(target) && !!owner && !!repo,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
  };
}

/**
 * The branch's most recent change request (open or not).
 * Returns null when it has none yet.
 */
export function usePrByBranch(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrSummary | null =>
      r.changeRequest ? toPrSummary(r.changeRequest) : null,
  });
}

/**
 * CI runs for the head commit. Empty unless it is open — a closed change
 * request's checks describe work nobody can act on.
 */
export function useChecks(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): CheckRun[] =>
      r.changeRequest?.state === "open"
        ? r.changeRequest.checkRuns.map(toCheckRun)
        : [],
  });
}

/**
 * Comments on the change request itself. Does NOT include review comments tied
 * to a file + line — those belong near the diff on the Changes tab.
 */
export function usePrComments(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrComment[] =>
      (r.changeRequest?.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
        htmlUrl: c.url,
      })),
  });
}

/** The last publish changes only when someone publishes — cheap to keep. */
const LAST_PUBLISHED_STALE = 5 * 60_000;

/**
 * The last publish — in Fast Preview every publish is a squash-merged change
 * request. Mounted by the header so the line is warm before the publish
 * surface opens; never polled, because it changes only when someone publishes.
 */
export function useLastPublishedPr(
  args: RepoArgs & { base: string | null; enabled?: boolean },
) {
  const { orgSlug, target, owner, repo, base } = args;
  return useQuery({
    queryKey: KEYS.githubLastPublishedPr(
      orgSlug,
      repoTargetKey(target),
      owner,
      repo,
      base,
    ),
    queryFn: () =>
      callStudioTool(orgSlug, "CHANGE_REQUEST_LAST_MERGED", {
        ...target,
        base: base as string,
      }),
    enabled:
      (args.enabled ?? true) &&
      !!base &&
      hasRepoCredential(target) &&
      !!owner &&
      !!repo,
    staleTime: LAST_PUBLISHED_STALE,
    select: (r): PrSummary | null =>
      r.changeRequest ? toPrSummary(r.changeRequest) : null,
  });
}

/** Max open change requests fetched for the picker; the tail is not shown. */
const OPEN_PRS_PER_PAGE = 50;

/**
 * Lists open change requests for the repository (most recently updated
 * first), capped at {@link OPEN_PRS_PER_PAGE}. Powers the branch picker's
 * "PRs" tab — selecting one is equivalent to selecting its head branch. No
 * polling: the picker is an ephemeral popover, so it relies on
 * refetch-on-open + `staleTime` rather than a background interval.
 */
export function useOpenPrs(args: RepoArgs & { enabled?: boolean }) {
  const { orgSlug, target, owner, repo } = args;
  return useQuery({
    queryKey: KEYS.githubOpenPrs(orgSlug, repoTargetKey(target), owner, repo),
    queryFn: () =>
      callStudioTool(orgSlug, "CHANGE_REQUEST_LIST_OPEN", {
        ...target,
        limit: OPEN_PRS_PER_PAGE,
      }),
    enabled:
      (args.enabled ?? true) && hasRepoCredential(target) && !!owner && !!repo,
    staleTime: STALE,
    select: (r): PrSummary[] => r.changeRequests.map(toPrSummary),
  });
}

/**
 * One CI run's full report — GitHub's check-run `output` markdown, or the tail
 * of a GitLab job's trace. The unified read returns a minimal run shape
 * without it, so the Checks tab loads this lazily when a row is expanded.
 */
export function useCheckRunDetail(
  args: RepoArgs & { checkRunId: string | null; enabled: boolean },
) {
  const { orgSlug, target, owner, repo, checkRunId } = args;
  return useQuery({
    queryKey: KEYS.githubCheckRun(
      orgSlug,
      repoTargetKey(target),
      owner,
      repo,
      checkRunId,
    ),
    queryFn: () =>
      callStudioTool(orgSlug, "CHANGE_REQUEST_CHECK_LOG", {
        ...target,
        checkId: checkRunId as string,
      }),
    enabled: args.enabled && !!checkRunId,
    staleTime: STALE,
    /**
     * The neutral read answers one body of text, where GitHub's check-run
     * output had a title, a summary and a text. `summary` is where the panel
     * already renders markdown, so the report goes there.
     */
    select: (r): CheckRunOutput => ({
      title: null,
      summary: r.report,
      text: null,
    }),
  });
}
