import type { BranchMeta, LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/components/sandbox/hooks/sandbox-events-context";
import { CLAIM_PHASE_COPY } from "@/components/sandbox/claim-phase-copy";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";
import { publishToBaseLabel } from "./publish-label.ts";
import { saveChangesDebug } from "./save-changes-debug.ts";
import type { TFunction } from "@/i18n/use-t.ts";

/**
 * Header copy for claim-phase variants while lifecycle is still `idle`.
 * `claiming` is intentionally excluded (too brief and indistinct from
 * no-claim-phase) and falls through to the generic "Starting sandbox…".
 * `ready` and `failed` are not in `CLAIM_PHASE_COPY` for the reasons
 * documented there; both also fall through here.
 */
function idleClaimCopy(kind: ClaimPhase["kind"]): string | undefined {
  if (kind === "claiming" || kind === "ready" || kind === "failed") {
    return undefined;
  }
  return CLAIM_PHASE_COPY[kind].short;
}

/**
 * Descriptor returned by selectHeaderButton. Callers translate action →
 * prompt via the message-templates module.
 *
 * `disabled: true` means the button renders as a status indicator (e.g.,
 * "Running tests…", "Awaiting review"), not clickable. `loading: true`
 * adds a spinner; use it for "data is fetching" and for "server-side work
 * in progress" (CI running). `variant` selects the button color: success
 * (green) for the happy-path Publish, special (purple) for post-merge
 * Continue, default for other actionable states, outline for non-actionable
 * status pills.
 */
export type HeaderButton = {
  label: string;
  action?:
    | "create-pr"
    | "reopen"
    | "rebase"
    | "fix-checks"
    | "mark-ready"
    | "resolve-comments"
    | "merge-split";
  disabled?: boolean;
  loading?: boolean;
  variant: "default" | "outline" | "success" | "special";
  tooltip?: string;
  /**
   * When true, the header renders a persistent green "Publish" button beside
   * the primary button (direct publish-to-base for deco-only changes). Set on
   * the states with local work not yet merged, so the state machine — not the
   * renderer — owns this affordance.
   */
  showPublishSide?: boolean;
  meta?: {
    failingChecks?: string[];
  };
};

type FailedConclusion =
  | "failure"
  | "timed_out"
  | "cancelled"
  | "action_required";

const FAILED_CONCLUSIONS = new Set<FailedConclusion>([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

/** Shared with the Fast Preview state machine (`cms-panel-state.ts`). */
export function isCheckFailed(c: CheckRun): boolean {
  return (
    c.status === "completed" &&
    FAILED_CONCLUSIONS.has(c.conclusion as FailedConclusion)
  );
}

/** Shared with the Fast Preview state machine (`cms-panel-state.ts`). */
export function isCheckInProgress(c: CheckRun): boolean {
  return c.status === "queued" || c.status === "in_progress";
}

export interface SelectHeaderButtonInput {
  lifecycle: LifecycleState;
  branch: BranchMeta;
  claimPhase: ClaimPhase | null;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  loading?: boolean;
  t: TFunction;
}

export function isPrStateActivelyLoading(query: {
  isPending: boolean;
  fetchStatus: string;
}): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}

export function selectHeaderButton(
  input: SelectHeaderButtonInput,
): HeaderButton {
  const { lifecycle, branch, pr, checks, reviews, loading, t } = input;

  if (loading) {
    return {
      label: t("thread.headerActions.loading"),
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: t("thread.headerActions.loadingBranchTooltip"),
    };
  }

  // Git operations work on the cloned repo, not on the dev server. So
  // the header tracks the lifecycle ONLY through clone/checkout — the
  // post-clone phases (installing / starting / running / *-failed /
  // crashed) intentionally fall through to the git/PR copy below. The
  // user can commit fixes for a broken install or push a hotfix while
  // the dev server is down; we don't want to block those flows on
  // sandbox health.
  switch (lifecycle.phase) {
    case "idle": {
      const label =
        (input.claimPhase && idleClaimCopy(input.claimPhase.kind)) ||
        t("thread.headerActions.startingSandbox");
      return {
        label,
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.waitingForDaemonTooltip"),
      };
    }
    case "cloning":
      return {
        label: t("thread.headerActions.cloningRepo"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.cloningRepoTooltip"),
      };
    case "clone-failed":
      return {
        label: t("thread.headerActions.cloneFailed"),
        disabled: true,
        variant: "outline",
        tooltip:
          lifecycle.error ||
          t("thread.headerActions.cloneFailedDefaultTooltip"),
      };
    case "checking-out":
      return {
        label: t("thread.headerActions.switchingTo", {
          branch: lifecycle.to,
        }),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.checkingOutTooltip", {
          branch: lifecycle.to,
        }),
      };
    // installing / starting / running / install-failed / start-failed /
    // crashed: intentionally fall through to git/PR logic below.
  }

  // Brief window after checkout completes but before the daemon emits
  // its first `branch` event with computed git metadata. Defensive —
  // the daemon emits it within a few hundred ms of checkout.
  if (branch.kind !== "ready") {
    return {
      label: t("thread.headerActions.loadingBranch"),
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: t("thread.headerActions.waitingForBranchTooltip"),
    };
  }
  const ready = branch;

  if (ready.workingTreeDirty) {
    return {
      label: t("thread.headerActions.submitForReview"),
      action: "create-pr",
      variant: "outline",
      tooltip: t("thread.headerActions.pushAndOpenPrTooltip", {
        branch: ready.branch,
        base: ready.base,
      }),
      showPublishSide: true,
    };
  }

  // `unpushed` can be a false positive when the sandbox hasn't fetched the
  // remote tracking ref (origin/<branch> missing). If the PR's head SHA
  // matches the local HEAD, the commits are already on the remote — skip
  // the push gate and fall through to the PR/merge logic below.
  const trulyUnpushed =
    ready.unpushed > 0 &&
    !(pr && ready.headSha && pr.headSha && ready.headSha === pr.headSha);

  if (trulyUnpushed) {
    if (!pr) {
      return {
        label: t("thread.headerActions.submitForReview"),
        action: "create-pr",
        variant: "outline",
        tooltip: t("thread.headerActions.pushAndOpenPrTooltip", {
          branch: ready.branch,
          base: ready.base,
        }),
        showPublishSide: true,
      };
    }
    return {
      label: t("thread.headerActions.submitForReview"),
      action: "create-pr",
      variant: "outline",
      tooltip: t("thread.headerActions.pushLocalCommitsTooltip", {
        prNumber: String(pr.number),
      }),
      showPublishSide: true,
    };
  }

  // Fall-through debug: why no local work to submit?
  saveChangesDebug("no local work — checking PR/sync state", {
    workingTreeDirty: ready.workingTreeDirty,
    unpushed: ready.unpushed,
    aheadOfBase: ready.aheadOfBase,
    behindBase: ready.behindBase,
    branch: ready.branch,
    base: ready.base,
    prMerged: pr?.merged ?? null,
    prState: pr?.state ?? null,
  });

  // Merged PR is terminal UNLESS the branch has advanced past the PR's
  // head (i.e. new commits were pushed after the merge). Squash-merges
  // leave the branch's pre-merge commits intact on origin/<branch> with
  // their original SHAs, so aheadOfBase alone can't distinguish
  // "work shipped, nothing new" from "new work since the merge". Compare
  // the branch's HEAD sha to the PR's head sha to decide.
  if (pr?.merged) {
    const branchAdvanced =
      !!ready.headSha && !!pr.headSha && ready.headSha !== pr.headSha;
    if (branchAdvanced) {
      return {
        label: t("thread.headerActions.continue"),
        action: "create-pr",
        variant: "special",
        tooltip: t("thread.headerActions.openNewPrTooltip"),
        showPublishSide: true,
      };
    }
    return {
      label: t("thread.headerActions.published"),
      disabled: true,
      variant: "outline",
      tooltip: t("thread.headerActions.prMergedTooltip", {
        prNumber: String(pr.number),
        base: pr.base,
      }),
    };
  }

  if (ready.aheadOfBase > 0) {
    if (pr && pr.state === "closed" && !pr.merged) {
      return {
        label: t("thread.headerActions.reopen"),
        action: "reopen",
        variant: "default",
        tooltip: t("thread.headerActions.reopenPrTooltip", {
          prNumber: String(pr.number),
        }),
      };
    }
    if (!pr) {
      return {
        label: t("thread.headerActions.submitForReview"),
        action: "create-pr",
        variant: "outline",
        tooltip: t("thread.headerActions.openPrForBranchTooltip", {
          branch: ready.branch,
          base: ready.base,
        }),
        showPublishSide: true,
      };
    }

    // pr.state === "open"
    const mergeableState = reviews?.mergeableState ?? "unknown";

    if (mergeableState === "dirty") {
      return {
        label: t("thread.headerActions.syncWith", { base: pr.base }),
        action: "rebase",
        variant: "default",
        tooltip: t("thread.headerActions.resolveConflictsTooltip", {
          base: pr.base,
        }),
      };
    }

    const failing = checks.filter(isCheckFailed).map((c) => c.name);
    if (failing.length > 0) {
      return {
        label: t("thread.headerActions.fixTests"),
        action: "fix-checks",
        variant: "default",
        tooltip: t("thread.headerActions.failingChecksTooltip", {
          checks: failing.join(", "),
        }),
        meta: { failingChecks: failing },
      };
    }

    const inProgress = checks.filter(isCheckInProgress);
    if (inProgress.length > 0) {
      return {
        label: t("thread.headerActions.runningTests"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.waitingOnChecksTooltip", {
          count: String(inProgress.length),
        }),
      };
    }

    if (reviews?.draft) {
      return {
        label: t("thread.headerActions.markReady"),
        action: "mark-ready",
        variant: "default",
        tooltip: t("thread.headerActions.markDraftReadyTooltip"),
      };
    }

    const unresolved = reviews?.unresolvedConversations ?? 0;
    if (unresolved > 0) {
      return {
        label: t("thread.headerActions.addressFeedback"),
        action: "resolve-comments",
        variant: "default",
        tooltip: t("thread.headerActions.unresolvedConversationsTooltip", {
          count: String(unresolved),
        }),
      };
    }

    if (reviews?.missingRequiredApprovals) {
      return {
        label: t("thread.headerActions.awaitingReview"),
        disabled: true,
        variant: "outline",
        tooltip: t("thread.headerActions.waitingForApprovalsTooltip"),
      };
    }

    return {
      label: publishToBaseLabel(pr.base, t),
      action: "merge-split",
      variant: "success",
      tooltip: t("thread.headerActions.squashMergeTooltip", {
        prNumber: String(pr.number),
        base: pr.base,
      }),
    };
  }

  return {
    label: t("thread.headerActions.upToDate"),
    disabled: true,
    variant: "outline",
    tooltip: t("thread.headerActions.branchInSyncTooltip", {
      base: ready.base,
    }),
  };
}
