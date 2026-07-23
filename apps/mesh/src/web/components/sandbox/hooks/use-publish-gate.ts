import { useQuery } from "@tanstack/react-query";
import {
  canPublishDirectly,
  combinePublishDiffs,
  fetchGitDiff,
  fetchGitStatus,
  hasGitLocalWork,
  isSandboxUnreachable,
  needsSmartReviewJudgment,
  smartReviewGate,
  type GitDiffResult,
  type GitStatus,
  type PublishGate,
  type PublishPolicy,
} from "../../thread/github/sandbox-git-api.ts";
import { useSmartReviewVerdict } from "./use-smart-review-verdict.ts";

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
  policy: PublishPolicy;
  enabled?: boolean;
}): { gate: PublishGate; ready: boolean } {
  const {
    orgSlug,
    virtualMcpId,
    branch,
    base,
    headSha,
    signature,
    policy,
    enabled = true,
  } = args;

  const query = useQuery<{ status: GitStatus; diff: GitDiffResult }>({
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
      return { status, diff: combinePublishDiffs(baseDiff, workingDiff) };
    },
    enabled: enabled && !!branch,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: (count, error) => !isSandboxUnreachable(error) && count < 2,
  });

  const status = query.data?.status ?? null;
  const diff = query.data?.diff ?? null;
  const needsJudge = needsSmartReviewJudgment(diff, policy);

  // In `smart` policy with code in the diff, defer to the cheap AI judge (cached
  // per diff content, no polling). Deco-only / non-smart cases skip it entirely.
  const { verdict, loading } = useSmartReviewVerdict({
    orgSlug,
    virtualMcpId,
    branch,
    status,
    diff,
    enabled: needsJudge,
  });

  // While the diff is still loading (or the sandbox is unreachable) don't gate
  // the button — let the click fall through to the dialog, which does its own
  // loading + gating. Only enforce the gate once we actually have the diff.
  if (!query.data)
    return { gate: { allowed: true, reason: null }, ready: false };
  if (!needsJudge)
    return { gate: canPublishDirectly(diff, policy), ready: true };
  return { gate: smartReviewGate(verdict, loading), ready: !loading };
}
