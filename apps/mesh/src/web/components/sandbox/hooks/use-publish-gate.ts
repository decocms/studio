import { useQuery } from "@tanstack/react-query";
import {
  canPublishDirectly,
  combinePublishDiffs,
  fetchGitDiff,
  fetchGitStatus,
  hasGitLocalWork,
  isSandboxUnreachable,
  type GitDiffResult,
  type PublishGate,
} from "../../thread/github/sandbox-git-api.ts";

function publishGateQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  base: string,
  signature: string,
) {
  return [
    "publish-gate",
    orgSlug,
    virtualMcpId,
    branch,
    base,
    signature,
  ] as const;
}

/**
 * Fetch the full direct-publish diff (committed base…head unioned with the
 * uncommitted working tree, mirroring the publish dialog's `loadPublishDiff`)
 * and evaluate whether it may be published directly. Lets the header's side
 * "Publish" button gate itself — disabled with a tooltip when the diff contains
 * code — instead of opening a dialog whose Publish button is already dead.
 *
 * `signature` (a fingerprint of the branch's git state from the daemon SSE)
 * feeds the query key so a commit/push/dirty-flip refetches immediately; the
 * poll interval backstops working-tree edits that keep the dirty flag set.
 */
export function usePublishGate(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  base: string;
  headSha?: string | null;
  signature: string;
  enabled?: boolean;
}): { gate: PublishGate; ready: boolean } {
  const {
    orgSlug,
    virtualMcpId,
    branch,
    base,
    headSha,
    signature,
    enabled = true,
  } = args;

  const query = useQuery<GitDiffResult>({
    queryKey: publishGateQueryKey(
      orgSlug,
      virtualMcpId,
      branch,
      base,
      signature,
    ),
    queryFn: async () => {
      const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
      const baseDiff =
        (status.aheadOfBase ?? 0) > 0
          ? await fetchGitDiff(orgSlug, virtualMcpId, branch, {
              base,
              ...(headSha ? { headSha } : {}),
            })
          : null;
      const workingDiff = hasGitLocalWork(status)
        ? await fetchGitDiff(orgSlug, virtualMcpId, branch)
        : null;
      return combinePublishDiffs(baseDiff, workingDiff);
    },
    enabled: enabled && !!branch,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: (count, error) => !isSandboxUnreachable(error) && count < 2,
  });

  // While the diff is still loading (or the sandbox is unreachable) don't gate
  // the button — let the click fall through to the dialog, which does its own
  // loading + gating. Only enforce the gate once we actually have the diff.
  if (!query.data)
    return { gate: { allowed: true, reason: null }, ready: false };
  return { gate: canPublishDirectly(query.data), ready: true };
}
