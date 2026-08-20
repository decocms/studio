import {
  canPublishDirectly,
  needsSmartReviewJudgment,
  resolvePathGate,
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
  /**
   * The changed-file manifest, for a surface that counts changes before it can
   * read them. Without it a null diff falls through as allowed, so such a
   * surface would publish ungated; with it the decision comes from
   * {@link resolvePathGate}, which never allows on incomplete information.
   */
  paths?: readonly string[] | null;
}): { gate: PublishGate; ready: boolean } {
  const {
    orgSlug,
    virtualMcpId,
    branch,
    status,
    diff,
    policy,
    judgeEnabled = true,
    paths = null,
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

  // Manifest known, bodies not: decide from paths.
  if (!diff && paths)
    return { gate: resolvePathGate(paths, policy), ready: false };
  // Neither known: fall through to the dialog, which loads and gates itself.
  if (!diff) return { gate: { allowed: true, reason: null }, ready: false };
  if (!needsJudge)
    return { gate: canPublishDirectly(diff, policy), ready: true };
  return { gate: smartReviewGate(verdict, loading), ready: !loading };
}
