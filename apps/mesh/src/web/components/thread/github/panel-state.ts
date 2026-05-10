import type {
  BranchMeta,
  DaemonStatus,
  LifecycleState,
} from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/web/components/vm/hooks/vm-events-context";
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

export interface SelectHeaderButtonInput {
  lifecycle: LifecycleState;
  branch: BranchMeta;
  status: DaemonStatus;
  claimPhase: ClaimPhase | null;
  pr: PrSummary | null;
  checks: CheckRun[];
  reviews: PrReviewSignals | null;
  loading?: boolean;
}

export function selectHeaderButton(
  input: SelectHeaderButtonInput,
): HeaderButton {
  const { lifecycle, branch, pr, checks, reviews, loading } = input;

  if (loading) {
    return {
      label: "Loading…",
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: "Loading branch and pull request status",
    };
  }

  // Sandbox-state precedence: header reflects boot/daemon state until
  // the dev server is up AND the daemon's status is healthy AND the
  // branch metadata has arrived. Only then does git/PR copy take over.
  switch (lifecycle.phase) {
    case "idle":
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
        tooltip: lifecycle.error || "git clone failed — see setup logs",
      };
    case "checking-out":
      return {
        label: `Switching to ${lifecycle.to}…`,
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: `Checking out ${lifecycle.to}`,
      };
    case "installing":
      return {
        label: "Installing packages…",
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: "Installing project dependencies",
      };
    case "starting":
      return {
        label: "Starting dev server…",
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: "Booting the dev server",
      };
    case "running":
      // Fall through to the post-sandbox checks below.
      break;
    default: {
      // Other lifecycle phases (installing/starting/install-failed/
      // start-failed/crashed) are handled in subsequent tasks. For now
      // they shouldn't be reached by any test, but we keep the function
      // total by falling through to the same "Loading…" pill the loading
      // flag uses.
      return {
        label: "Loading…",
        disabled: true,
        loading: true,
        variant: "outline",
      };
    }
  }

  // From here on, lifecycle.phase === "running". `branch` should be ready;
  // if it isn't, fall through to the same Loading… pill — a real fix for
  // this race lands in a later task.
  if (branch.kind !== "ready") {
    return {
      label: "Loading…",
      disabled: true,
      loading: true,
      variant: "outline",
    };
  }
  const ready = branch;

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
