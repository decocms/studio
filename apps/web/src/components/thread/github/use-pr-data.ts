/**
 * PR panel data hooks.
 *
 * All reads go through the unified `pull_request_read` tool on
 * github-mcp-server, which exposes sub-calls via a `method` arg:
 *   method: "get"             → PR details
 *   method: "get_files"       → files changed
 *   method: "get_check_runs"  → CI check runs for the head commit
 *   method: "get_comments"    → issue-level comments
 *   method: "get_reviews"     → submitted reviews
 *
 * Tool args use camelCase (pullNumber, perPage). Listing PRs by branch
 * still goes through the separate `list_pull_requests` tool.
 */

import { useMCPClient, useMCPToolCallQuery } from "@/sdk";

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
  /** SHA of the PR head commit — used to fetch check runs. */
  headSha: string;
  /**
   * `owner/name` of the repo the head branch lives in. Differs from the base
   * repo for cross-fork PRs (or null when the fork was deleted) — such PRs
   * can't be opened as a local branch. Same as the base repo for internal PRs.
   */
  headRepoFullName: string | null;
  htmlUrl: string;
  author: string;
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

/** Maps a raw github-mcp list/get PR object into the app's PrSummary. */
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
  };
}

/**
 * Fetches the first PR matching a branch head (open or closed).
 * Returns null when no PR exists yet for that branch.
 */
export function usePrByBranch(args: RepoArgs & { branch: string | null }) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<PrSummary | null>({
    client,
    toolName: "list_pull_requests",
    toolArguments: {
      owner: args.owner,
      repo: args.repo,
      state: "all",
      ...(args.branch ? { head: `${args.owner}:${args.branch}` } : {}),
      perPage: 1,
    },
    enabled:
      !!args.branch && !!args.connectionId && !!args.owner && !!args.repo,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
    select: (r) => {
      assertToolOk(r);
      const arr = extractPullRequestList(r);
      if (arr.length === 0) return null;
      return mapRawPr(arr[0]!);
    },
  });
}

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
 * Fetches CI check runs for a PR's head commit via
 * pull_request_read(get_check_runs).
 */
export function useChecks(
  args: RepoArgs & { prNumber: number | null | undefined },
) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<CheckRun[]>({
    client,
    toolName: "pull_request_read",
    toolArguments: {
      method: "get_check_runs",
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.prNumber ?? 0,
    },
    enabled: !!args.prNumber,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
    select: (r) => {
      assertToolOk(r);
      // Accept both `{ check_runs: [...] }` envelopes and raw arrays.
      const raw = extractToolJson<
        { check_runs?: Record<string, unknown>[] } | Record<string, unknown>[]
      >(r);
      const runs = Array.isArray(raw) ? raw : (raw?.check_runs ?? []);
      return runs.map((c): CheckRun => {
        const startedAt = (c as { started_at?: string }).started_at;
        const completedAt = (c as { completed_at?: string }).completed_at;
        const durationMs =
          startedAt && completedAt
            ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
            : null;
        return {
          id: String((c as { id?: unknown }).id ?? ""),
          name: String((c as { name?: unknown }).name ?? ""),
          status:
            ((c as { status?: unknown }).status as CheckRun["status"]) ??
            "completed",
          conclusion:
            ((c as { conclusion?: unknown }).conclusion as
              | CheckRun["conclusion"]
              | undefined) ?? null,
          htmlUrl: String((c as { html_url?: unknown }).html_url ?? ""),
          durationMs,
        };
      });
    },
  });
}

/**
 * Fetches a single check run's full `output` (title/summary/text markdown) via
 * the github-mcp first-party GET_CHECK_RUN tool. The list tool
 * (pull_request_read get_check_runs) returns a minimal shape without `output`,
 * so the Checks tab lazily loads this when a row is expanded.
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

/**
 * Issue-level comments on a PR via pull_request_read(get_comments).
 * Does NOT return review comments tied to a file + line — those belong
 * near the diff on the Changes tab and are out of scope for this hook.
 */
export function usePrComments(
  args: RepoArgs & { prNumber: number | null | undefined },
) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<PrComment[]>({
    client,
    toolName: "pull_request_read",
    toolArguments: {
      method: "get_comments",
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.prNumber ?? 0,
    },
    enabled: !!args.prNumber,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
    select: (r) => {
      assertToolOk(r);
      const arr = extractToolJson<Record<string, unknown>[]>(r);
      if (!Array.isArray(arr)) return [];
      return arr.map((c): PrComment => {
        const user = (c as { user?: { login?: string } }).user;
        return {
          id: Number((c as { id?: unknown }).id ?? 0),
          author: user?.login ?? "",
          body: String((c as { body?: unknown }).body ?? ""),
          createdAt: String((c as { created_at?: unknown }).created_at ?? ""),
          htmlUrl: String((c as { html_url?: unknown }).html_url ?? ""),
        };
      });
    },
  });
}
