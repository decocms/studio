import { useQuery } from "@tanstack/react-query";
import { usePreferences } from "@/hooks/use-preferences.ts";
import {
  fetchReviewVerdict,
  isSandboxUnreachable,
  reviewDiffSignature,
  type GitDiffResult,
  type GitStatus,
  type ReviewVerdict,
} from "../../thread/github/sandbox-git-api.ts";

function smartReviewVerdictQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  signature: string,
  language: string,
) {
  return [
    "smart-review-verdict",
    orgSlug,
    virtualMcpId,
    branch,
    signature,
    language,
  ] as const;
}

/**
 * Ask the cheap-model judge whether a `smart`-policy code diff needs review.
 * Keyed by the diff content so the AI is called at most once per distinct diff
 * (no `refetchInterval` — the verdict is stable for a given diff). `enabled`
 * should be `needsSmartReviewJudgment(diff, policy)` so we never spend a model
 * call on deco-only diffs or non-smart policies.
 */
export function useSmartReviewVerdict(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  status: GitStatus | null;
  diff: GitDiffResult | null;
  enabled: boolean;
}): { verdict: ReviewVerdict | null; loading: boolean } {
  const { orgSlug, virtualMcpId, branch, threadId, status, diff, enabled } =
    args;
  const [{ language }] = usePreferences();
  const signature = diff ? reviewDiffSignature(diff) : "";
  const canRun = enabled && !!branch && !!status && !!diff && signature !== "";

  const query = useQuery<ReviewVerdict>({
    queryKey: smartReviewVerdictQueryKey(
      orgSlug,
      virtualMcpId,
      branch,
      signature,
      language,
    ),
    queryFn: () =>
      fetchReviewVerdict(
        { orgSlug, virtualMcpId, branch, threadId },
        { status: status!, diff: diff!, language },
      ),
    enabled: canRun,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: (count, error) => !isSandboxUnreachable(error) && count < 1,
  });

  return {
    verdict: query.data ?? null,
    loading: canRun && query.isFetching && !query.data,
  };
}
