/**
 * usePrReviews — draft / mergeability / unresolved-conversation /
 * missing-approvals signals for the branch's change request. A selector over
 * the same `CHANGE_REQUEST_STATE` entry `usePrByBranch` and `useChecks` read,
 * so it costs no extra request.
 */

import { useQuery } from "@tanstack/react-query";

import { prStateQueryOptions, type RepoArgs } from "./use-pr-data.ts";

export type MergeableState = "clean" | "dirty" | "blocked" | "unknown";

export interface PrReviewSignals {
  draft: boolean;
  mergeableState: MergeableState;
  unresolvedConversations: number;
  missingRequiredApprovals: boolean;
}

type Args = RepoArgs & { branch: string | null };

/**
 * The panel's four-value vocabulary, from the three neutral facts.
 *
 * It stays the panel's own word rather than the interface's: "blocked" means
 * blocked on a PERSON, which is a statement about this UI's state machine, not
 * about what a provider reported. Conflicts and unknowns come first because
 * neither is something a reviewer can clear.
 */
export function toMergeableState(cr: {
  conflicting: boolean | null;
  reviewBlocked: boolean;
  unresolvedConversations: number;
}): MergeableState {
  if (cr.conflicting === true) return "dirty";
  if (cr.conflicting === null) return "unknown";
  return cr.reviewBlocked || cr.unresolvedConversations > 0
    ? "blocked"
    : "clean";
}

export function usePrReviews(args: Args) {
  return useQuery({
    ...prStateQueryOptions(args),
    select: (r): PrReviewSignals | null => {
      const cr = r.changeRequest;
      if (!cr) return null;
      return {
        draft: cr.draft,
        mergeableState: toMergeableState(cr),
        unresolvedConversations: cr.unresolvedConversations,
        missingRequiredApprovals: cr.reviewBlocked,
      };
    },
  });
}
