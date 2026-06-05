import type { BranchMeta, LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "@/web/components/sandbox/hooks/sandbox-events-context";
import { CLAIM_PHASE_COPY } from "@/web/components/sandbox/claim-phase-copy";
import type { CheckRun, PrSummary } from "./use-pr-data.ts";
import type { PrReviewSignals } from "./use-pr-reviews.ts";
import { publishToBaseLabel } from "./publish-label.ts";
import { saveChangesDebug } from "./save-changes-debug.ts";

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
        "Starting sandbox…";
      return {
        label,
        disabled: true,
        loading: true,
        variant: "outline",
        tooltip: "Waiting for the sandbox daemon to come online",
      };
    }
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
    // installing / starting / running / install-failed / start-failed /
    // crashed: intentionally fall through to git/PR logic below.
  }

  // Brief window after checkout completes but before the daemon emits
  // its first `branch` event with computed git metadata. Defensive —
  // the daemon emits it within a few hundred ms of checkout.
  if (branch.kind !== "ready") {
    return {
      label: "Loading branch…",
      disabled: true,
      loading: true,
      variant: "outline",
      tooltip: "Waiting for branch metadata from the sandbox daemon",
    };
  }
  const ready = branch;

  if (ready.workingTreeDirty) {
    return {
      label: "Save changes",
      action: "commit-and-push",
      variant: "default",
      tooltip: "Commit and push local changes",
    };
  }

  if (ready.unpushed > 0) {
    if (!pr && ready.aheadOfBase > 0) {
      return {
        label: "Submit for review",
        action: "create-pr",
        variant: "default",
        tooltip: `Push and open a PR for ${ready.branch} → ${ready.base}`,
      };
    }
    return {
      label: "Save changes",
      action: "commit-and-push",
      variant: "default",
      tooltip: "Push local commits",
    };
  }

  // Fall-through debug: why not Save changes?
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
      label: publishToBaseLabel(pr.base),
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
