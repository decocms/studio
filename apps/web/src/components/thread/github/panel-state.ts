import type { BranchMeta, LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/components/sandbox/hooks/sandbox-events-context";
import { CLAIM_PHASE_COPY } from "@/components/sandbox/claim-phase-copy";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";
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
 * - `publish` — open the publish dialog in publish-only mode: review the
 *   diff, then publish (opening a PR and squash-merging in one flow).
 * - `create-pr` — open the publish dialog in open-PR mode (review first).
 * - `merge` — squash-merge the open PR directly ("Publish anyway").
 * - `sync` / `rebase` — bring `base` into the working branch (chat prompts;
 *   both surface as "Get latest").
 * - `review` — ask the chat agent for a read-only review pass.
 * - `open-pr-page` — open the PR on GitHub in a new tab.
 * - `reopen` / `fix-checks` / `mark-ready` / `resolve-comments` — chat
 *   prompts (see message-templates).
 */
export type HeaderAction =
  | "publish"
  | "create-pr"
  | "reopen"
  | "rebase"
  | "fix-checks"
  | "mark-ready"
  | "resolve-comments"
  | "merge"
  | "sync"
  | "review"
  | "open-pr-page";

/** One entry of the split button's dropdown half. `key` is the React key. */
export interface HeaderMenuItem {
  key: string;
  label: string;
  action: HeaderAction;
  tooltip?: string;
}

/**
 * Descriptor returned by selectHeaderButton. Mirrors the Fast Preview machine
 * (`cms-panel-state.ts`) in shape AND language: one split button whose
 * primary half is the next action ("Review & Publish", "Get latest",
 * "Waiting for review", …) and whose dropdown half carries the secondary
 * ones. The sandbox surface keeps its extra powers — lifecycle pills and
 * agent-driven states ("Fix checks", "Mark ready", "Address feedback").
 *
 * `disabled: true` means the primary half renders as a status indicator, not
 * clickable — the menu half stays operable. `loading: true` adds a spinner;
 * reserve it for a genuine wait. `variant`: brand for the happy-path
 * Review & Publish, special for post-merge Continue, default for other
 * actionable states, outline for status pills.
 */
export type HeaderButton = {
  label: string;
  action?: HeaderAction;
  disabled?: boolean;
  loading?: boolean;
  variant: "default" | "outline" | "brand" | "special";
  tooltip?: string;
  menu: HeaderMenuItem[];
  meta?: {
    failingChecks?: string[];
    /**
     * Set on the publishable-open-PR state: the PR already cleared every
     * review gate the header enforces (conflicts, checks, draft, comments,
     * approvals), so the publish dialog must not re-gate it by diff content.
     */
    publishPolicyOverride?: "open";
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

/** Appends "Get latest" when the branch is behind, including on the disabled "Up to date" pill. */
function withGetLatest(
  menu: HeaderMenuItem[],
  branch: BranchMeta,
  t: TFunction,
): HeaderMenuItem[] {
  if (branch.kind !== "ready" || branch.behindBase <= 0) return menu;
  return [
    ...menu,
    {
      key: "get-latest",
      label: t("thread.cmsActions.getLatest"),
      action: "sync",
      tooltip: t("thread.cmsActions.getLatestTooltip"),
    },
  ];
}

/** "Submit for review" — open a PR for teammates without publishing. */
function submitForReviewItem(t: TFunction): HeaderMenuItem {
  return {
    key: "submit-for-review",
    label: t("thread.headerActions.submitForReview"),
    action: "create-pr",
  };
}

/**
 * Overlays a "checks still running" tooltip, Fast Preview style: while
 * anything is queued the failure set isn't final, so the button stays
 * clickable and the tooltip carries the progress instead of a spinner.
 */
function withRunningChecksTooltip(
  button: HeaderButton,
  checks: CheckRun[],
  t: TFunction,
): HeaderButton {
  const running = checks.filter(isCheckInProgress).length;
  if (running === 0) return button;
  const done = checks.filter((c) => c.status === "completed").length;
  return {
    ...button,
    tooltip: t("thread.cmsActions.checksRunning", {
      done,
      total: checks.length,
    }),
  };
}

/** Picks the header button; first match wins, so order is behavior. */
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
      menu: [],
    };
  }

  // Setup phases gate the header; once the app has run (or failed to), git/PR copy below takes over.
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
    // Still booting: nothing runs yet, so nothing to review or publish. The failure phases fall through — pushing a fix is the point there.
    case "installing":
      return {
        label: t("thread.headerActions.installingPackages"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.installingPackagesTooltip"),
        menu: [],
      };
    case "starting":
      return {
        label: t("thread.headerActions.startingApp"),
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: t("thread.headerActions.startingAppTooltip"),
        menu: [],
      };
    // running/*-failed/crashed: fall through to git/PR.
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

  // `unpushed` is a false positive when origin/<branch> was never fetched; a PR head SHA matching local HEAD proves the commits are already remote.
  const trulyUnpushed =
    ready.unpushed > 0 &&
    !(pr && ready.headSha && pr.headSha && ready.headSha === pr.headSha);

  if (ready.workingTreeDirty || trulyUnpushed) {
    return {
      label: t("thread.cmsActions.reviewAndPublish"),
      action: "publish",
      variant: "brand",
      menu: withGetLatest(
        withPrLink([submitForReviewItem(t)], pr, t),
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
        menu: withGetLatest(withPrLink([], pr, t), ready, t),
      };
    }
    return {
      label: t("thread.headerActions.upToDate"),
      disabled: true,
      variant: "outline",
      tooltip: t("thread.headerActions.prMergedTooltip", {
        prNumber: String(pr.number),
        base: pr.base,
      }),
      menu: withGetLatest(withPrLink([], pr, t), ready, t),
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
        menu: withGetLatest(withPrLink([], pr, t), ready, t),
      };
    }
    if (!pr) {
      return {
        label: t("thread.cmsActions.reviewAndPublish"),
        action: "publish",
        variant: "brand",
        menu: withGetLatest([submitForReviewItem(t)], ready, t),
      };
    }

    // pr.state === "open"
    const mergeableState = reviews?.mergeableState ?? "unknown";

    // Conflicts outrank CI, and "Get latest" is the fix.
    if (mergeableState === "dirty") {
      return {
        label: t("thread.cmsActions.getLatest"),
        action: "rebase",
        variant: "default",
        tooltip: t("thread.cmsActions.getLatestTooltip"),
        menu: [
          {
            key: "resolve-on-github",
            label: t("thread.cmsActions.resolveOnGithub"),
            action: "open-pr-page",
          },
        ],
      };
    }

    // Fast Preview rule: while anything is queued the failure set isn't final, so red checks become "Fix checks" only once the run settles.
    const running = checks.filter(isCheckInProgress).length;
    const failing = checks.filter(isCheckFailed).map((c) => c.name);
    if (running === 0 && failing.length > 0) {
      // "Publish anyway" is the developer's call; branch protection still wins server-side.
      return {
        label: t("thread.headerActions.fixChecks"),
        action: "fix-checks",
        variant: "default",
        tooltip: t("thread.headerActions.failingChecksTooltip", {
          checks: failing.join(", "),
        }),
        meta: { failingChecks: failing },
        menu: withGetLatest(
          withPrLink(
            [
              {
                key: "publish-anyway",
                label: t("thread.headerActions.publishAnyway"),
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

    if (reviews?.draft) {
      return withRunningChecksTooltip(
        {
          label: t("thread.headerActions.markReady"),
          action: "mark-ready",
          variant: "default",
          tooltip: t("thread.headerActions.markDraftReadyTooltip"),
          menu: withGetLatest(withPrLink([], pr, t), ready, t),
        },
        checks,
        t,
      );
    }

    const unresolved = reviews?.unresolvedConversations ?? 0;
    if (unresolved > 0) {
      return withRunningChecksTooltip(
        {
          label: t("thread.headerActions.addressFeedback"),
          action: "resolve-comments",
          variant: "default",
          tooltip: t("thread.headerActions.unresolvedConversationsTooltip", {
            count: String(unresolved),
          }),
          menu: withGetLatest(withPrLink([], pr, t), ready, t),
        },
        checks,
        t,
      );
    }

    if (reviews?.missingRequiredApprovals) {
      // Blocked on a human; the primary opens the PR, the only place they act.
      return withRunningChecksTooltip(
        {
          label: t("thread.cmsActions.waitingForReview"),
          action: "open-pr-page",
          variant: "outline",
          tooltip: t("thread.headerActions.waitingForApprovalsTooltip"),
          menu: withGetLatest(withPrLink([], pr, t), ready, t),
        },
        checks,
        t,
      );
    }

    return withRunningChecksTooltip(
      {
        label: t("thread.cmsActions.reviewAndPublish"),
        action: "publish",
        variant: "brand",
        meta: { publishPolicyOverride: "open" },
        menu: withGetLatest(
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
      },
      checks,
      t,
    );
  }

  return {
    label: t("thread.headerActions.upToDate"),
    disabled: true,
    variant: "outline",
    tooltip: t("thread.headerActions.branchInSyncTooltip", {
      base: ready.base,
    }),
    menu: withGetLatest([], ready, t),
  };
}
