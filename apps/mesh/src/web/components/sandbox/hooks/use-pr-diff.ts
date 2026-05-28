import { useMCPClient } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import {
  countGitDiffFiles,
  fetchGithubPrDiff,
} from "../../thread/github/github-pr-diff.ts";
import {
  fetchGitDiff,
  type GitDiffResult,
} from "../../thread/github/sandbox-git-api.ts";

function prDiffQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  base: string,
  headSha: string,
  pullNumber: number,
  connectionId: string,
) {
  return [
    "pr-diff",
    orgSlug,
    virtualMcpId,
    branch,
    base,
    headSha,
    pullNumber,
    connectionId,
  ] as const;
}

export function usePrDiff(args: {
  orgSlug: string;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  base: string;
  headSha: string;
  pullNumber: number;
  connectionId: string;
  owner: string;
  repo: string;
  enabled?: boolean;
}) {
  const {
    orgSlug,
    orgId,
    virtualMcpId,
    branch,
    base,
    headSha,
    pullNumber,
    connectionId,
    owner,
    repo,
    enabled = true,
  } = args;

  const githubClient = useMCPClient({
    connectionId,
    orgId,
    orgSlug,
  });

  return useQuery<GitDiffResult>({
    queryKey: prDiffQueryKey(
      orgSlug,
      virtualMcpId,
      branch,
      base,
      headSha,
      pullNumber,
      connectionId,
    ),
    queryFn: async () => {
      try {
        const sandboxDiff = await fetchGitDiff(orgSlug, virtualMcpId, branch, {
          base,
          headSha,
        });
        if (countGitDiffFiles(sandboxDiff) > 0) return sandboxDiff;

        return fetchGithubPrDiff(githubClient, {
          owner,
          repo,
          pullNumber,
          base,
          headSha,
          mergeBaseSha: sandboxDiff.mergeBaseSha,
        });
      } catch {
        return fetchGithubPrDiff(githubClient, {
          owner,
          repo,
          pullNumber,
          base,
          headSha,
        });
      }
    },
    enabled: enabled && !!branch && !!headSha && !!connectionId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
