/**
 * The publish popover's read side. Git state and the last publish are fetched
 * as one suspense load, so the surface goes straight from a single skeleton to
 * its final render instead of stacking spinners. A failed load lands in
 * `loadError` (and a null `lastPublishedPr`), rendered inline by the popover
 * rather than thrown to an error boundary.
 */

import { useSuspenseQuery } from "@tanstack/react-query";
import type { GithubMcpClient } from "./github-pr-api.ts";
import {
  combinePublishDiffs,
  fetchGitDiff,
  fetchGitStatus,
  hasGitLocalWork,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";
import { fetchLastPublishedPr, type PrSummary } from "./use-pr-data.ts";

interface CmsPublishStateArgs {
  githubClient: GithubMcpClient;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  baseBranch: string;
  owner: string;
  repo: string;
}

interface CmsPublishState {
  status: GitStatus | null;
  diff: GitDiffResult | null;
  lastPublishedPr: PrSummary | null;
  loadError: string | null;
  /** Re-runs the load; the popover calls it after a discard. */
  refresh: () => Promise<unknown>;
}

type LoadedPublishState = Omit<CmsPublishState, "refresh">;

function cmsPublishStateQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  baseBranch: string,
) {
  return [
    "cms-publish-popover-state",
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
  ] as const;
}

export function useCmsPublishState(args: CmsPublishStateArgs): CmsPublishState {
  const {
    githubClient,
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
    owner,
    repo,
  } = args;

  const query = useSuspenseQuery<LoadedPublishState>({
    queryKey: cmsPublishStateQueryKey(
      orgSlug,
      virtualMcpId,
      branch,
      baseBranch,
    ),
    queryFn: async (): Promise<LoadedPublishState> => {
      const lastPublishedPromise = fetchLastPublishedPr(githubClient, {
        owner,
        repo,
        base: baseBranch,
      }).catch(() => null);
      try {
        const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
        const baseDiff =
          (status.aheadOfBase ?? 0) > 0
            ? await fetchGitDiff(orgSlug, virtualMcpId, branch, {
                base: baseBranch,
              })
            : null;
        const workingDiff = hasGitLocalWork(status)
          ? await fetchGitDiff(orgSlug, virtualMcpId, branch)
          : null;
        return {
          status,
          diff: combinePublishDiffs(baseDiff, workingDiff),
          lastPublishedPr: await lastPublishedPromise,
          loadError: null,
        };
      } catch (error) {
        return {
          status: null,
          diff: null,
          lastPublishedPr: await lastPublishedPromise,
          loadError: error instanceof Error ? error.message : String(error),
        };
      }
    },
    staleTime: 0,
    gcTime: 0,
  });

  return { ...query.data, refresh: () => query.refetch() };
}
