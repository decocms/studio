import type { BranchStatus } from "@/web/components/vm/hooks/use-vm-events";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";

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
    | "commit-and-push"
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

function isCheckFailed(c: CheckRun): boolean {
  return (
    c.status === "completed" &&
    FAILED_CONCLUSIONS.has(c.conclusion as FailedConclusion)
  );
}

function isCheckInProgress(c: CheckRun): boolean {
  return c.status === "queued" || c.status === "in_progress";
}

export function selectHeaderButton(input: {
  branchStatus: BranchStatus | null;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  loading?: boolean;
}): HeaderButton {
  const { branchStatus, pr, checks, reviews, loading } = input;

  if (!branchStatus || loading) {
    return {
      label: "Loading…",
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: "Loading branch and pull request status",
    };
  }

  switch (branchStatus.kind) {
    case "initializing":
      return {
        label: "Starting sandbox…",
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: "Waiting for the sandbox daemon to come online",
      };
    case "cloning":
      return {
        label: "Cloning repo…",
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: "Cloning the project repository",
      };
    case "clone-failed":
      return {
        label: "Clone failed",
        disabled: true,
        variant: "outline",
        tooltip: branchStatus.error || "git clone failed — see setup logs",
      };
    case "checking-out":
      return {
        label: `Switching to ${branchStatus.to}…`,
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: `Checking out ${branchStatus.to}`,
      };
    case "checkout-failed":
      return {
        label: "Checkout failed",
        disabled: true,
        variant: "outline",
        tooltip: branchStatus.error || "git checkout failed — see setup logs",
      };
    case "ready":
      break;
    default: {
      const _exhaustive: never = branchStatus;
      void _exhaustive;
      break;
    }
  }

  // From here on, branchStatus.kind === "ready" — narrow it.
  const ready = branchStatus;

  const hasLocalWork = ready.workingTreeDirty || ready.unpushed > 0;
  if (hasLocalWork) {
    return {
      label: "Save changes",
      action: "commit-and-push",
      variant: "default",
      tooltip: "Commit and push local changes",
    };
  }

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
        label: "Continue",
        action: "create-pr",
        variant: "special",
        tooltip: "Open a new PR with the latest commits",
      };
    }
    return {
      label: "Published",
      disabled: true,
      variant: "outline",
      tooltip: `PR #${pr.number} merged into ${pr.base}`,
    };
  }

  if (ready.aheadOfBase > 0) {
    if (pr && pr.state === "closed" && !pr.merged) {
      return {
        label: "Reopen",
        action: "reopen",
        variant: "default",
        tooltip: `Reopen PR #${pr.number}`,
      };
    }
    if (!pr) {
      return {
        label: "Submit for review",
        action: "create-pr",
        variant: "default",
        tooltip: `Open a PR for ${ready.branch} → ${ready.base}`,
      };
    }

    // pr.state === "open"
    const mergeableState = reviews?.mergeableState ?? "unknown";

    if (mergeableState === "dirty") {
      return {
        label: `Sync with ${pr.base}`,
        action: "rebase",
        variant: "default",
        tooltip: `Resolve conflicts with ${pr.base} before merging`,
      };
    }

    const failing = checks.filter(isCheckFailed).map((c) => c.name);
    if (failing.length > 0) {
      return {
        label: "Fix tests",
        action: "fix-checks",
        variant: "default",
        tooltip: `Failing: ${failing.join(", ")}`,
        meta: { failingChecks: failing },
      };
    }

    const inProgress = checks.filter(isCheckInProgress);
    if (inProgress.length > 0) {
      return {
        label: "Running tests…",
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: `Waiting on ${inProgress.length} check${
          inProgress.length === 1 ? "" : "s"
        } to finish`,
      };
    }

    if (reviews?.draft) {
      return {
        label: "Mark ready",
        action: "mark-ready",
        variant: "default",
        tooltip: "Mark draft PR ready for review",
      };
    }

    const unresolved = reviews?.unresolvedConversations ?? 0;
    if (unresolved > 0) {
      return {
        label: "Address feedback",
        action: "resolve-comments",
        variant: "default",
        tooltip: `${unresolved} unresolved conversation${
          unresolved === 1 ? "" : "s"
        }`,
      };
    }

    if (reviews?.missingRequiredApprovals) {
      return {
        label: "Awaiting review",
        disabled: true,
        variant: "outline",
        tooltip: "Waiting for required approvals",
      };
    }

    return {
      label: "Publish",
      action: "merge-split",
      variant: "success",
      tooltip: `Squash-merge PR #${pr.number} into ${pr.base}`,
    };
  }

  return {
    label: "Up to date",
    disabled: true,
    variant: "outline",
    tooltip: `Branch is in sync with ${ready.base}`,
  };
}
