/** Fast Preview (CMS) header button state machine; see ./panel-state.ts for vibecoding's. */

import type { BranchMeta } from "@decocms/sandbox/shared";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  isCheckFailed,
  isCheckInProgress,
  isPrStateActivelyLoading,
} from "./panel-state.ts";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";

/**
 * What a click resolves to. The renderer maps these to mutations; the state
 * machine never performs them.
 *
 * - `publish` — merge the PR (opening one first when there isn't one yet).
 * - `request-approval` — open the PR so a reviewer can approve it.
 * - `get-latest` — bring `base` into the working branch.
 * - `open-pr` — open the PR on GitHub in a new tab.
 */
export type CmsAction =
  | "publish"
  | "request-approval"
  | "get-latest"
  | "open-pr"
  | "retry-status";

/** One entry of the split button's dropdown half. `key` is the React key. */
export interface CmsMenuItem {
  key: string;
  label: string;
  action: CmsAction;
  tooltip?: string;
}

/**
 * Descriptor returned by {@link selectCmsHeaderButton}.
 *
 * An absent `action` means the primary half is an inert status pill. `loading`
 * puts a spinner in the primary half and is reserved for a genuine wait.
 * `disabled` and a non-empty `menu` can coexist: "Up to date" has nothing to
 * publish yet still offers "Get latest" when the branch is behind.
 */
export interface CmsHeaderButton {
  label: string;
  /** Absent = inert status pill. */
  action?: CmsAction;
  variant: "brand" | "warning" | "outline" | "default";
  disabled?: boolean;
  /** Spinner in the primary half. */
  loading?: boolean;
  tooltip?: string;
  menu: CmsMenuItem[];
}

export interface SelectCmsHeaderButtonInput {
  branch: BranchMeta;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  /** A publish is in flight — optimistic, set at click time. */
  publishing: boolean;
  /** A block write is in flight; the branch state is mid-change. */
  saving: boolean;
  /** A "Get latest" merge is in flight. */
  syncing: boolean;
  /** A failed status read is being retried. */
  statusRetrying: boolean;
  /** Branch/PR/check data is still being fetched. */
  loading: boolean;
  /** Why the branch status could not be read, if it could not. */
  statusError: string | null;
  t: TFunction;
}

function viewOnGithubItem(t: TFunction): CmsMenuItem {
  return {
    key: "view-on-github",
    label: t("thread.cmsActions.viewOnGithub"),
    action: "open-pr",
  };
}

/**
 * Appends "Get latest" to `menu` when the branch has commits on `base` it
 * hasn't taken in yet. Applied to every state whose primary action isn't
 * already `get-latest`, including the disabled "Up to date" pill.
 */
function withGetLatest(
  menu: CmsMenuItem[],
  branch: BranchMeta,
  t: TFunction,
): CmsMenuItem[] {
  if (branch.kind !== "ready" || branch.behindBase <= 0) return menu;
  return [
    ...menu,
    {
      key: "get-latest",
      label: t("thread.cmsActions.getLatest"),
      action: "get-latest",
      tooltip: t("thread.cmsActions.getLatestTooltip"),
    },
  ];
}

/**
 * Folds check-run status into a button descriptor. Only meaningful for the two
 * open-PR states — checks exist only once a PR does.
 *
 * Running beats failing: while anything is still queued the failure set isn't
 * final. A failure never disables the button; publishing with red checks is a
 * judgement call the editor is allowed to make, so it only recolours to
 * `warning` and explains itself in the tooltip.
 *
 * Only a genuine wait animates. A button the editor may click right now must
 * sit still; the tooltip carries the progress.
 */
function applyCheckTreatment(
  button: CmsHeaderButton,
  checks: CheckRun[],
  runningTreatment: "loading" | "none",
  t: TFunction,
): CmsHeaderButton {
  const total = checks.length;
  if (total === 0) return button;

  const running = checks.filter(isCheckInProgress).length;
  if (running > 0) {
    const done = checks.filter((c) => c.status === "completed").length;
    const tooltip = t("thread.cmsActions.checksRunning", { done, total });
    return runningTreatment === "loading"
      ? { ...button, loading: true, tooltip }
      : { ...button, tooltip };
  }

  const failed = checks.filter(isCheckFailed).length;
  if (failed > 0) {
    return {
      ...button,
      variant: "warning",
      tooltip: t("thread.cmsActions.checksFailing", { failed, total }),
    };
  }

  return button;
}

/**
 * Whether the branch sits exactly on a PR that has already been merged.
 *
 * A squash-merge leaves the branch's own commits on origin with their original
 * SHAs, so `aheadOfBase` stays positive after a successful publish. Publishing
 * moves the editor to a fresh branch, but when that hasn't happened the branch
 * is level with its merged PR — and offering to publish again would open a
 * second pull request for content that is already live.
 */
function isLevelWithMergedPr(
  pr: PrSummary | null,
  branch: BranchMeta,
): boolean {
  return Boolean(
    pr?.merged &&
      pr.headSha &&
      branch.kind === "ready" &&
      !branch.workingTreeDirty &&
      branch.headSha === pr.headSha,
  );
}

interface QueryLoadState {
  isPending: boolean;
  fetchStatus: string;
}

/**
 * Whether the PR picture is still assembling, as ONE window rather than three.
 *
 * `checks` and `reviews` cannot start until `pr` returns their number, so
 * treating only `pr` as loading paints a confident state from data still
 * missing the part that can contradict it — and a failing check landing a beat
 * later recolours a green button to warning in front of the editor, which
 * reads as a bug rather than as convergence.
 */
export function isCmsStateSettling(input: {
  pr: PrSummary | null;
  prQuery: QueryLoadState;
  checksQuery: QueryLoadState;
  reviewsQuery: QueryLoadState;
}): boolean {
  if (isPrStateActivelyLoading(input.prQuery)) return true;
  if (input.pr?.state !== "open" || input.pr.merged) return false;
  return (
    isPrStateActivelyLoading(input.checksQuery) ||
    isPrStateActivelyLoading(input.reviewsQuery)
  );
}

/** Not live yet: one `/git/status` backend commits each save, the other doesn't. */
function hasUnpublishedWork(
  branch: Extract<BranchMeta, { kind: "ready" }>,
): boolean {
  return branch.aheadOfBase > 0 || branch.workingTreeDirty;
}

/** Picks the Fast Preview header button; first match wins, so order is behavior. */
export function selectCmsHeaderButton(
  input: SelectCmsHeaderButtonInput,
): CmsHeaderButton {
  const { branch, pr, checks, reviews, publishing, saving, loading, t } = input;

  // A failed status read is not a slow one; spinning on it never resolves.
  if (branch.kind !== "ready" && input.statusError) {
    return {
      label: t("thread.cmsActions.retry"),
      action: "retry-status",
      variant: "outline",
      disabled: input.statusRetrying,
      loading: input.statusRetrying,
      tooltip: input.statusError,
      menu: [],
    };
  }

  // Fetching and "branch metadata not here yet" are one state to the editor.
  if (loading || branch.kind !== "ready") {
    return {
      label: t("thread.headerActions.loading"),
      variant: "outline",
      disabled: true,
      loading: true,
      menu: [],
    };
  }

  if (publishing) {
    return {
      label: t("thread.cmsActions.publishing"),
      variant: "outline",
      disabled: true,
      loading: true,
      menu: [],
    };
  }

  /** A merge is rewriting the branch under the editor. */
  if (input.syncing) {
    return {
      label: t("thread.cmsActions.gettingLatest"),
      variant: "outline",
      disabled: true,
      loading: true,
      menu: [],
    };
  }

  /** Publishing mid-write would ship whichever half of the edit landed. */
  if (saving) {
    return {
      label: t("thread.headerActions.saving"),
      variant: "outline",
      disabled: true,
      loading: true,
      menu: [],
    };
  }

  const openPr = pr && pr.state === "open" && !pr.merged ? pr : null;

  if (openPr) {
    const mergeableState = reviews?.mergeableState ?? "unknown";

    // Conflicts outrank CI, and "Get latest" is already the primary here.
    if (mergeableState === "dirty") {
      return {
        label: t("thread.cmsActions.getLatest"),
        action: "get-latest",
        variant: "default",
        tooltip: t("thread.cmsActions.getLatestTooltip"),
        menu: [
          {
            key: "resolve-on-github",
            label: t("thread.cmsActions.resolveOnGithub"),
            action: "open-pr",
          },
        ],
      };
    }

    // Blocked on a human; the primary opens the PR, the only place they act.
    if (mergeableState === "blocked" || reviews?.draft) {
      return applyCheckTreatment(
        {
          label: t("thread.cmsActions.waitingForReview"),
          action: "open-pr",
          variant: "outline",
          menu: withGetLatest([viewOnGithubItem(t)], branch, t),
        },
        checks,
        "loading",
        t,
      );
    }

    // clean / unstable / behind / unknown — all publishable.
    return applyCheckTreatment(
      {
        label: t("thread.cmsActions.reviewAndPublish"),
        action: "publish",
        variant: "brand",
        menu: withGetLatest([viewOnGithubItem(t)], branch, t),
      },
      checks,
      "none",
      t,
    );
  }

  if (isLevelWithMergedPr(pr, branch)) {
    return {
      label: t("thread.headerActions.upToDate"),
      variant: "outline",
      disabled: true,
      menu: withGetLatest([], branch, t),
    };
  }

  if (hasUnpublishedWork(branch)) {
    return {
      label: t("thread.cmsActions.reviewAndPublish"),
      action: "publish",
      variant: "brand",
      menu: withGetLatest(
        [
          {
            key: "request-approval",
            label: t("thread.headerActions.submitForReview"),
            action: "request-approval",
          },
        ],
        branch,
        t,
      ),
    };
  }

  // Disabled primary, live menu: nothing to publish but base may have moved.
  return {
    label: t("thread.headerActions.upToDate"),
    variant: "outline",
    disabled: true,
    menu: withGetLatest([], branch, t),
  };
}
