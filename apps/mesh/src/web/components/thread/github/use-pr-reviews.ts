/**
 * usePrReviews — fetches draft/mergeable/unresolved-conversation/missing-
 * approvals signals for an open PR. Backed by github-mcp-server's
 * `get_pull_request`. Mirrors the polling and stale-time conventions of
 * usePrByBranch and useChecks.
 *
 * Semantic notes:
 * - `missingRequiredApprovals` is a heuristic: mergeable_state="blocked"
 *   and no unresolved conversations. GitHub doesn't expose approval-
 *   requirement state via this endpoint directly; this is the best signal
 *   available without an additional review-threads call.
 */

import { useMCPClient, useMCPToolCallQuery } from "@decocms/mesh-sdk";

import { extractToolJson } from "./extract-tool-json.ts";

export type MergeableState =
  | "clean"
  | "dirty"
  | "unstable"
  | "blocked"
  | "unknown"
  | "behind";

export interface PrReviewSignals {
  draft: boolean;
  mergeableState: MergeableState;
  unresolvedConversations: number;
  missingRequiredApprovals: boolean;
}

const POLL = 60_000;
const STALE = 30_000;

interface Args {
  orgId: string;
  orgSlug: string;
  connectionId: string;
  owner: string;
  repo: string;
  prNumber: number | null | undefined;
}

export function usePrReviews(args: Args) {
  const client = useMCPClient({
    connectionId: args.connectionId,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  return useMCPToolCallQuery<PrReviewSignals | null>({
    client,
    toolName: "pull_request_read",
    toolArguments: {
      method: "get",
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.prNumber ?? 0,
    },
    enabled: !!args.prNumber,
    refetchInterval: POLL,
    refetchIntervalInBackground: false,
    staleTime: STALE,
    select: (r) => {
      const p = extractToolJson<Record<string, unknown>>(r);
      if (!p) return null;
      const ms = (p.mergeable_state as MergeableState | undefined) ?? "unknown";
      const draft = Boolean(p.draft ?? false);
      const reviewCommentsCount = Number(p.review_comments ?? 0);
      const unresolvedConversations =
        ms === "blocked" && reviewCommentsCount > 0 ? reviewCommentsCount : 0;
      const missingRequiredApprovals =
        ms === "blocked" && unresolvedConversations === 0;
      return {
        draft,
        mergeableState: ms,
        unresolvedConversations,
        missingRequiredApprovals,
      };
    },
  });
}
