/**
 * usePrReviews — draft/mergeable/unresolved-conversation/missing-approvals
 * signals for the branch's PR. A selector over the same `GITHUB_PR_STATE` entry
 * `usePrByBranch` and `useChecks` read, so it costs no extra request.
 *
 * `missingRequiredApprovals` is `reviewDecision` and `unresolvedConversations`
 * counts unresolved review threads — both were inferences over REST before.
 */

import { useQuery } from "@tanstack/react-query";

import { prStateQueryOptions } from "./use-pr-data.ts";

export type MergeableState = "clean" | "dirty" | "blocked" | "unknown";

export interface PrReviewSignals {
  draft: boolean;
  mergeableState: MergeableState;
  unresolvedConversations: number;
  missingRequiredApprovals: boolean;
}

interface Args {
  orgId: string;
  orgSlug: string;
  connectionId: string;
  owner: string;
  repo: string;
  branch: string | null;
}

export function usePrReviews(args: Args) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrReviewSignals | null => {
      const pr = r.pullRequest;
      if (!pr) return null;
      return {
        draft: pr.draft,
        mergeableState: pr.mergeableState,
        unresolvedConversations: pr.unresolvedConversations,
        missingRequiredApprovals: pr.missingRequiredApprovals,
      };
    },
  });
}
