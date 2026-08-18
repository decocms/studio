import {
  canPublishDirectly,
  needsSmartReviewJudgment,
  smartReviewGate,
  type GitDiffResult,
  type GitStatus,
  type PublishGate,
  type PublishPolicy,
} from "../../thread/github/sandbox-git-api.ts";
import { useSmartReviewVerdict } from "./use-smart-review-verdict.ts";

/**
 * Combine an already-loaded diff + policy (+ the smart AI verdict) into the
 * final publish gate. Single source of truth for the "does this publish need
 * review?" decision, used by the publish dialog (which supplies its own
 * loaded diff). `judgeEnabled` lets the dialog restrict the AI call to its
 * publish-only intent.
 */
export function useResolvedPublishGate(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  status: GitStatus | null;
  diff: GitDiffResult | null;
  policy: PublishPolicy;
  judgeEnabled?: boolean;
}): { gate: PublishGate; ready: boolean } {
  const {
    orgSlug,
    virtualMcpId,
    branch,
    status,
    diff,
    policy,
    judgeEnabled = true,
  } = args;

  const needsJudge = judgeEnabled && needsSmartReviewJudgment(diff, policy);

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
  if (!diff) return { gate: { allowed: true, reason: null }, ready: false };
  if (!needsJudge)
    return { gate: canPublishDirectly(diff, policy), ready: true };
  return { gate: smartReviewGate(verdict, loading), ready: !loading };
}
