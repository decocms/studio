import type { BranchMeta, LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/components/sandbox/hooks/sandbox-events-context";
import { CLAIM_PHASE_COPY } from "@/components/sandbox/claim-phase-copy";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";
import type { PublishGate } from "./sandbox-git-api.ts";
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
 * What a click resolves to. The renderer maps these to mutations or chat
 * prompts; the state machine never performs them.
 *
 * - `create-pr` — open the publish dialog in open-PR mode.
 * - `merge` — squash-merge the open PR into its base.
 * - `publish-direct` — open the publish dialog in publish-only mode
 *   (direct publish-to-base for deco-only changes).
 * - `sync` — bring `base` into the working branch.
 * - `review` — ask the chat agent for a read-only review pass.
 * - `open-pr-page` — open the PR on GitHub in a new tab.
 * - `reopen` / `rebase` / `fix-checks` / `mark-ready` / `resolve-comments` —
 *   chat prompts (see message-templates).
 */
export type HeaderAction =
  | "create-pr"
  | "reopen"
  | "rebase"
  | "fix-checks"
  | "mark-ready"
  | "resolve-comments"
  | "merge"
  | "publish-direct"
  | "sync"
  | "review"
  | "open-pr-page";

/** One entry of the split button's dropdown half. `key` is the React key. */
export interface HeaderMenuItem {
  key: string;
  label: string;
  action: HeaderAction;
  tooltip?: string;
  disabled?: boolean;
}

/**
 * Descriptor returned by selectHeaderButton. Mirrors the Fast Preview machine
 * (`cms-panel-state.ts`): one split button whose primary half is the next
 * action and whose dropdown half carries the secondary ones.
 *
 * `disabled: true` means the primary half renders as a status indicator
 * (e.g., "Running checks…", "Merged"), not clickable — the menu half stays
 * operable. `loading: true` adds a spinner; use it for "data is fetching" and
 * for "server-side work in progress" (CI running). `variant` selects the
 * button color: success (green) for the happy-path Merge, special (purple)
 * for post-merge Continue, default for other actionable states, outline for
 * non-actionable status pills.
 */
export type HeaderButton = {
  label: string;
  action?: HeaderAction;
  disabled?: boolean;
  loading?: boolean;
  variant: "default" | "outline" | "success" | "special";
  tooltip?: string;
  menu: HeaderMenuItem[];
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
  /** Gate for "Publish directly"; null = not pre-fetched (item enabled, dialog gates on open). */
  publishGate?: PublishGate | null;
  loading?: boolean;
  t: TFunction;
}

export function isPrStateActivelyLoading(query: {
  isPending: boolean;
  fetchStatus: string;
}): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}

function viewOnGithubItem(t: TFunction): HeaderMenuItem {
  return {
    key: "view-on-github",
    label: t("thread.cmsActions.viewOnGithub"),
    action: "open-pr-page",
  };
}

/** Appends "View on GitHub" when there is a PR page to open. */
function withPrLink(
  menu: HeaderMenuItem[],
  pr: PrSummary | null,
  t: TFunction,
): HeaderMenuItem[] {
  if (!pr) return menu;
  return [...menu, viewOnGithubItem(t)];
}

/** Appends "Sync with {base}" when the branch is behind, including on the disabled "Up to date" pill. */
function withSync(
  menu: HeaderMenuItem[],
  branch: BranchMeta,
  t: TFunction,
): HeaderMenuItem[] {
  if (branch.kind !== "ready" || branch.behindBase <= 0) return menu;
  return [
    ...menu,
    {
      key: "sync",
      label: t("thread.headerActions.syncWith", { base: branch.base }),
      action: "sync",
      tooltip: t("thread.headerActions.syncTooltip"),
    },
  ];
}

/** "Publish directly" — the old green side Publish button as a gated menu item; with no pre-fetched gate it stays enabled and the publish dialog gates on open. */
function directPublishItem(
  gate: PublishGate | null | undefined,
  t: TFunction,
): HeaderMenuItem {
  const pending = gate?.pending ?? false;
  const allowed = gate?.allowed ?? true;
  return {
    key: "publish-direct",
    label: t("thread.headerActions.publishDirectly"),
    action: "publish-direct",
    disabled: pending || !allowed,
    tooltip: pending
      ? t("thread.headerActions.reviewingChanges")
      : allowed
        ? t("thread.headerActions.publishDirectlySkipReview")
        : (gate?.reason ?? t("thread.headerActions.publishNeedsReview")),
  };
}

/** Picks the header button; first match wins, so order is behavior. */
export function selectHeaderButton(
  input: SelectHeaderButtonInput,
): HeaderButton {
  const { lifecycle, branch, pr, checks, reviews, publishGate, loading, t } =
    input;

  if (loading) {
    return {
      label: t("thread.headerActions.loading"),
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: t("thread.headerActions.loadingBranchTooltip"),
      menu: [],
    };
  }

  // Git works on the clone, not the dev server: only clone/checkout gate the header; post-clone phases fall through to the git/PR copy below.
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
        menu: [],
      };
    }
    case "cloning":
      return {
        label: t("thread.headerActions.cloningRepo"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.cloningRepoTooltip"),
        menu: [],
      };
    case "clone-failed":
      return {
        label: t("thread.headerActions.cloneFailed"),
        disabled: true,
        variant: "outline",
        tooltip:
          lifecycle.error ||
          t("thread.headerActions.cloneFailedDefaultTooltip"),
        menu: [],
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
        menu: [],
      };
    // installing/starting/running/*-failed/crashed: fall through to git/PR.
  }

  // Defensive: the brief window between checkout and the daemon's first `branch` event.
  if (branch.kind !== "ready") {
    return {
      label: t("thread.headerActions.loadingBranch"),
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: t("thread.headerActions.waitingForBranchTooltip"),
      menu: [],
    };
  }
  const ready = branch;

  if (ready.workingTreeDirty) {
    return {
      label: t("thread.headerActions.openPr"),
      action: "create-pr",
      variant: "outline",
      tooltip: t("thread.headerActions.pushAndOpenPrTooltip", {
        branch: ready.branch,
        base: ready.base,
      }),
      menu: withSync(
        withPrLink([directPublishItem(publishGate, t)], pr, t),
        ready,
        t,
      ),
    };
  }

  // `unpushed` is a false positive when origin/<branch> was never fetched; a PR head SHA matching local HEAD proves the commits are already remote.
  const trulyUnpushed =
    ready.unpushed > 0 &&
    !(pr && ready.headSha && pr.headSha && ready.headSha === pr.headSha);

  if (trulyUnpushed) {
    return {
      label: t("thread.headerActions.openPr"),
      action: "create-pr",
      variant: "outline",
      tooltip: pr
        ? t("thread.headerActions.pushLocalCommitsTooltip", {
            prNumber: String(pr.number),
          })
        : t("thread.headerActions.pushAndOpenPrTooltip", {
            branch: ready.branch,
            base: ready.base,
          }),
      menu: withSync(
        withPrLink([directPublishItem(publishGate, t)], pr, t),
        ready,
        t,
      ),
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

  // Merged PR is terminal unless HEAD moved past the PR head — squash-merges keep pre-merge commits on origin/<branch>, so aheadOfBase alone can't tell "shipped" from "new work".
  if (pr?.merged) {
    const branchAdvanced =
      !!ready.headSha && !!pr.headSha && ready.headSha !== pr.headSha;
    if (branchAdvanced) {
      return {
        label: t("thread.headerActions.continue"),
        action: "create-pr",
        variant: "special",
        tooltip: t("thread.headerActions.openNewPrTooltip"),
        menu: withSync(
          withPrLink([directPublishItem(publishGate, t)], pr, t),
          ready,
          t,
        ),
      };
    }
    return {
      label: t("thread.headerActions.merged"),
      disabled: true,
      variant: "outline",
      tooltip: t("thread.headerActions.prMergedTooltip", {
        prNumber: String(pr.number),
        base: pr.base,
      }),
      menu: withSync(withPrLink([], pr, t), ready, t),
    };
  }

  if (ready.aheadOfBase > 0) {
    if (pr && pr.state === "closed" && !pr.merged) {
      return {
        label: t("thread.headerActions.reopenPr"),
        action: "reopen",
        variant: "default",
        tooltip: t("thread.headerActions.reopenPrTooltip", {
          prNumber: String(pr.number),
        }),
        menu: withSync(withPrLink([], pr, t), ready, t),
      };
    }
    if (!pr) {
      return {
        label: t("thread.headerActions.openPr"),
        action: "create-pr",
        variant: "outline",
        tooltip: t("thread.headerActions.openPrForBranchTooltip", {
          branch: ready.branch,
          base: ready.base,
        }),
        menu: withSync([directPublishItem(publishGate, t)], ready, t),
      };
    }

    // pr.state === "open"
    const mergeableState = reviews?.mergeableState ?? "unknown";

    if (mergeableState === "dirty") {
      return {
        label: t("thread.headerActions.resolveConflicts"),
        action: "rebase",
        variant: "default",
        tooltip: t("thread.headerActions.resolveConflictsTooltip", {
          base: pr.base,
        }),
        menu: [
          {
            key: "resolve-on-github",
            label: t("thread.cmsActions.resolveOnGithub"),
            action: "open-pr-page",
          },
        ],
      };
    }

    const failing = checks.filter(isCheckFailed).map((c) => c.name);
    if (failing.length > 0) {
      // "Merge anyway" with red checks is the developer's call; branch protection still wins server-side.
      return {
        label: t("thread.headerActions.fixChecks"),
        action: "fix-checks",
        variant: "default",
        tooltip: t("thread.headerActions.failingChecksTooltip", {
          checks: failing.join(", "),
        }),
        meta: { failingChecks: failing },
        menu: withSync(
          withPrLink(
            [
              {
                key: "merge-anyway",
                label: t("thread.headerActions.mergeAnyway"),
                action: "merge",
                tooltip: t("thread.headerActions.squashMergeTooltip", {
                  prNumber: String(pr.number),
                  base: pr.base,
                }),
              },
            ],
            pr,
            t,
          ),
          ready,
          t,
        ),
      };
    }

    const inProgress = checks.filter(isCheckInProgress);
    if (inProgress.length > 0) {
      return {
        label: t("thread.headerActions.runningChecks"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.waitingOnChecksTooltip", {
          count: String(inProgress.length),
        }),
        menu: withSync(withPrLink([], pr, t), ready, t),
      };
    }

    if (reviews?.draft) {
      return {
        label: t("thread.headerActions.markReady"),
        action: "mark-ready",
        variant: "default",
        tooltip: t("thread.headerActions.markDraftReadyTooltip"),
        menu: withSync(withPrLink([], pr, t), ready, t),
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
        menu: withSync(withPrLink([], pr, t), ready, t),
      };
    }

    if (reviews?.missingRequiredApprovals) {
      // Blocked on a human; the primary opens the PR, the only place they act.
      return {
        label: t("thread.headerActions.awaitingReview"),
        action: "open-pr-page",
        variant: "outline",
        tooltip: t("thread.headerActions.waitingForApprovalsTooltip"),
        menu: withSync(withPrLink([], pr, t), ready, t),
      };
    }

    return {
      label: t("thread.headerActions.mergeToBase", { base: pr.base }),
      action: "merge",
      variant: "success",
      tooltip: t("thread.headerActions.squashMergeTooltip", {
        prNumber: String(pr.number),
        base: pr.base,
      }),
      menu: withSync(
        withPrLink(
          [
            {
              key: "review",
              label: t("thread.headerActions.review"),
              action: "review",
            },
          ],
          pr,
          t,
        ),
        ready,
        t,
      ),
    };
  }

  return {
    label: t("thread.headerActions.upToDate"),
    disabled: true,
    variant: "outline",
    tooltip: t("thread.headerActions.branchInSyncTooltip", {
      base: ready.base,
    }),
    menu: withSync([], ready, t),
  };
}
