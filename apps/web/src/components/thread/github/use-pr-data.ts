/**
 * PR panel data hooks. The branch's PR, its check runs, its review state and its
 * comments all come from ONE polled read — the `GITHUB_PR_STATE` tool. The hooks
 * below are selectors over that one cache entry (they share
 * `KEYS.githubPrState`), so mounting all four costs one request and every
 * surface reads the same instant of the PR.
 *
 * Still on github-mcp-server: `list_pull_requests` for the branch picker's
 * "PRs" tab (a repo-wide list, not this PR), and `GET_CHECK_RUN` for one run's
 * `output` markdown when a Checks row is expanded.
 */

import { useQuery } from "@tanstack/react-query";

import { useMCPClient, useMCPToolCallQuery } from "@/sdk";
import { callStudioTool } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

import { extractPullRequestList } from "./github-pr-api.ts";
import { assertToolOk, extractToolJson } from "./extract-tool-json.ts";
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
  /** SHA of the PR head commit — used to key the diff. */
  headSha: string;
  /**
   * `owner/name` of the repo the head branch lives in. Differs from the base
   * repo for cross-fork PRs (or null when the fork was deleted) — such PRs
   * can't be opened as a local branch. Same as the base repo for internal PRs.
   */
  headRepoFullName: string | null;
  htmlUrl: string;
  author: string;
  /**
   * Files the PR touches. null when the source could not say — the repo-wide
   * PR list does not carry it — so a caller must not read null as "no changes".
   */
  changedFiles: number | null;
}

const POLL = 60_000;
const STALE = 30_000;

interface RepoArgs {
  orgId: string;
  orgSlug: string;
  connectionId: string;
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
  id: string;
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
  id: number;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}

type PrState = Awaited<
  ReturnType<typeof callStudioTool<"GITHUB_PR_STATE">>
>["pullRequest"];

/** Maps a raw github-mcp list PR object into the app's PrSummary. */
function mapRawPr(p: Record<string, unknown>): PrSummary {
  const base = p.base as Record<string, unknown> | undefined;
  const head = p.head as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  const user = p.user as Record<string, unknown> | undefined;
  return {
    number: (p.number as number) ?? 0,
    title: (p.title as string) ?? "",
    body: (p.body as string) ?? "",
    state: p.state === "closed" ? ("closed" as const) : ("open" as const),
    merged: (p.merged_at as string | null) != null,
    mergedAt: (p.merged_at as string | null) ?? null,
    base: (base?.ref as string) ?? "main",
    head: (head?.ref as string) ?? "",
    headSha: (head?.sha as string) ?? "",
    headRepoFullName: (headRepo?.full_name as string) ?? null,
    htmlUrl: (p.html_url as string) ?? "",
    author: (user?.login as string) ?? "",
    changedFiles: null,
  };
}

/** The PrSummary view of the unified read. */
function toPrSummary(pr: NonNullable<PrState>): PrSummary {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    base: pr.base,
    head: pr.head,
    headSha: pr.headSha,
    headRepoFullName: pr.headRepoFullName,
    htmlUrl: pr.htmlUrl,
    author: pr.author,
    changedFiles: pr.changedFiles,
  };
}

/**
 * The one PR read every panel hook selects from. Spread this rather than
 * restating the key — two hooks that disagree about it would double the poll.
 */
export function prStateQueryOptions(
  args: RepoArgs & { branch: string | null },
) {
  const { orgSlug, connectionId, owner, repo, branch } = args;
  return {
    queryKey: KEYS.githubPrState(orgSlug, connectionId, owner, repo, branch),
    queryFn: () =>
      callStudioTool(orgSlug, "GITHUB_PR_STATE", {
        connectionId,
        owner,
        repo,
        branch: branch as string,
      }),
    enabled: !!branch && !!connectionId && !!owner && !!repo,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
  };
}

/**
 * The branch's most recent pull request (open or closed).
 * Returns null when no PR exists yet for that branch.
 */
export function usePrByBranch(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrSummary | null =>
      r.pullRequest ? toPrSummary(r.pullRequest) : null,
  });
}

/**
 * Check runs for the PR's head commit. Empty unless the PR is open — a closed
 * PR's checks describe work nobody can act on.
 */
export function useChecks(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): CheckRun[] =>
      r.pullRequest?.state === "open" ? r.pullRequest.checks : [],
  });
}

/**
 * Issue-level comments on the PR. Does NOT include review comments tied to a
 * file + line — those belong near the diff on the Changes tab.
 */
export function usePrComments(args: RepoArgs & { branch: string | null }) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrComment[] => r.pullRequest?.comments ?? [],
  });
}

/**
 * The last publish — in Fast Preview every publish is a squash-merged PR.
 * Mounted by the header so the line is warm before the publish surface opens;
 * never polled, because it changes only when someone publishes.
 */
export function useLastPublishedPr(
  args: RepoArgs & { base: string | null; enabled?: boolean },
) {
  const { orgSlug, connectionId, owner, repo, base } = args;
  return useQuery({
    queryKey: KEYS.githubLastPublishedPr(
      orgSlug,
      connectionId,
      owner,
      repo,
      base,
    ),
    queryFn: () =>
      callStudioTool(orgSlug, "GITHUB_LAST_PUBLISHED_PR", {
        connectionId,
        owner,
        repo,
        base: base as string,
      }),
    enabled:
      (args.enabled ?? true) && !!base && !!connectionId && !!owner && !!repo,
    staleTime: LAST_PUBLISHED_STALE,
    select: (r): PrSummary | null =>
      r.pullRequest
        ? {
            ...r.pullRequest,
            state: "closed" as const,
            merged: true,
            headRepoFullName: null,
            changedFiles: null,
          }
        : null,
  });
}

/** The last publish changes only when someone publishes — cheap to keep. */
const LAST_PUBLISHED_STALE = 5 * 60_000;

/** Max open PRs fetched for the picker; the tail beyond this is not shown. */
const OPEN_PRS_PER_PAGE = 50;

/**
 * Lists open pull requests for the repo (most recent first, as GitHub returns
 * them), capped at {@link OPEN_PRS_PER_PAGE}. Powers the branch picker's "PRs"
 * tab — selecting a PR is equivalent to selecting its head branch (a PR is
 * just a branch). No polling: the picker is an ephemeral popover, so it relies
 * on refetch-on-open + `staleTime` rather than a background interval.
 */
export function useOpenPrs(args: RepoArgs & { enabled?: boolean }) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<PrSummary[]>({
    client,
    toolName: "list_pull_requests",
    toolArguments: {
      owner: args.owner,
      repo: args.repo,
      state: "open",
      perPage: OPEN_PRS_PER_PAGE,
    },
    enabled:
      (args.enabled ?? true) &&
      !!args.connectionId &&
      !!args.owner &&
      !!args.repo,
    staleTime: STALE,
    select: (r) => {
      assertToolOk(r);
      return extractPullRequestList(r).map(mapRawPr);
    },
  });
}

/**
 * Fetches a single check run's full `output` (title/summary/text markdown) via
 * the github-mcp first-party GET_CHECK_RUN tool. The unified PR read returns a
 * minimal check shape without `output`, so the Checks tab lazily loads this
 * when a row is expanded.
 */
export function useCheckRunDetail(
  args: RepoArgs & { checkRunId: number | null; enabled: boolean },
) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<CheckRunOutput>({
    client,
    toolName: "GET_CHECK_RUN",
    toolArguments: {
      owner: args.owner,
      repo: args.repo,
      checkRunId: args.checkRunId ?? 0,
    },
    enabled: args.enabled && !!args.checkRunId,
    staleTime: STALE,
    select: (r) => {
      assertToolOk(r);
      const d = extractToolJson<{ output?: Partial<CheckRunOutput> }>(r);
      return {
        title: d?.output?.title ?? null,
        summary: d?.output?.summary ?? null,
        text: d?.output?.text ?? null,
      };
    },
  });
}
