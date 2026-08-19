/**
 * The one publish sequence, shared by Fast Preview's publish popover and the
 * coding session's publish dialog. Publishing runs push → sync → open (or
 * update) the pull request → squash-merge; submitting for review runs the same
 * push → open-pr prefix and stops there. Neither surface owns the steps, so a
 * change to the sequence lands here exactly once.
 */

import type { CoAuthorIdentity } from "@decocms/sandbox/shared";
import { toast } from "sonner";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  openPullRequestForBranch,
  squashMergePullRequest,
  type CreatedPullRequest,
  type GithubMcpClient,
} from "./github-pr-api.ts";
import { publishGitChanges, rebaseGitBranch } from "./sandbox-git-api.ts";

/** The steps a publish runs, in order. Submitting for review stops at `open-pr`. */
type PublishStep = "push" | "sync" | "open-pr" | "merge";

/**
 * A failure attributed to the step that produced it. `pr` is set only when the
 * merge failed after the pull request was already opened — the work is not
 * lost, it is sitting in that open PR.
 */
export class PublishStepError extends Error {
  constructor(
    message: string,
    readonly step: PublishStep,
    readonly pr?: CreatedPullRequest,
  ) {
    super(message);
    this.name = "PublishStepError";
  }
}

/**
 * Where a publish goes: the sandbox branch it pushes, and the pull request it
 * opens — or updates, when the branch already has one open.
 */
export interface PublishTarget {
  orgSlug: string;
  virtualMcpId: string;
  /** Sandbox branch — what gets pushed. */
  branch: string;
  baseBranch: string;
  githubClient: GithubMcpClient;
  owner: string;
  repo: string;
  /** Branch name on GitHub; the sandbox's HEAD can differ from `branch`. */
  headBranch: string;
  coAuthor?: CoAuthorIdentity;
  /** The branch's already-open pull request, updated instead of opening a new one. */
  existingOpenPr?: CreatedPullRequest;
}

/** Pull-request title/body and the commit message, from one authored note. */
interface PublishMessage {
  title: string;
  body?: string;
  message: string;
}

/**
 * Derive what the pull request and the commit are called. An empty title falls
 * back to `fallbackTitle`; the commit message is title and body joined, and
 * degrades to the title alone when the author wrote neither.
 */
export function publishMessageParts(input: {
  title: string;
  body: string;
  fallbackTitle: string;
}): PublishMessage {
  const title = input.title.trim();
  const body = input.body.trim();
  const prTitle = title || input.fallbackTitle;
  return {
    title: prTitle,
    body: body || undefined,
    message: [title, body].filter(Boolean).join("\n\n") || prTitle,
  };
}

/** Single-textarea surfaces author title and body as one note: line 1 titles it. */
export function publishNoteParts(
  note: string,
  fallbackTitle: string,
): PublishMessage {
  const lines = note.trim().split("\n");
  return publishMessageParts({
    title: lines[0] ?? "",
    body: lines.slice(1).join("\n"),
    fallbackTitle,
  });
}

async function runStep<T>(
  step: PublishStep,
  fallback: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new PublishStepError(
      error instanceof Error ? error.message : fallback,
      step,
    );
  }
}

function pushChanges(target: PublishTarget, message: string): Promise<void> {
  return publishGitChanges(
    target.orgSlug,
    target.virtualMcpId,
    target.branch,
    message,
  );
}

function openPullRequest(
  target: PublishTarget,
  parts: PublishMessage,
): Promise<CreatedPullRequest> {
  return openPullRequestForBranch(target.githubClient, {
    owner: target.owner,
    repo: target.repo,
    branch: target.headBranch,
    title: parts.title,
    body: parts.body,
    base: target.baseBranch,
    coAuthor: target.coAuthor,
    existing: target.existingOpenPr,
  });
}

/**
 * push → sync → open (or update) the pull request → squash-merge. Every failure
 * arrives as a {@link PublishStepError}; hand it to {@link reportPublishFailure}
 * for the presentation both surfaces share.
 */
export async function runPublishFlow(
  target: PublishTarget,
  parts: PublishMessage,
  t: TFunction,
): Promise<CreatedPullRequest> {
  await runStep("push", t("thread.publishDialog.failedPushChanges"), () =>
    pushChanges(target, parts.message),
  );
  await runStep("sync", t("thread.publishDialog.failedRebase"), () =>
    rebaseGitBranch(
      target.orgSlug,
      target.virtualMcpId,
      target.branch,
      target.baseBranch,
    ),
  );
  const pr = await runStep(
    "open-pr",
    t("thread.publishDialog.failedOpenPullRequest"),
    () => openPullRequest(target, parts),
  );
  try {
    await squashMergePullRequest(target.githubClient, {
      owner: target.owner,
      repo: target.repo,
      pullNumber: pr.number,
      commitTitle: parts.title,
      commitMessage: parts.body,
      coAuthor: target.coAuthor,
    });
  } catch (error) {
    throw new PublishStepError(
      error instanceof Error
        ? error.message
        : t("thread.publishDialog.failedMergePullRequest"),
      "merge",
      pr,
    );
  }
  return pr;
}

/**
 * push → open (or update) the pull request, and stop. GitHub requires the head
 * on the remote, so this pushes even when the commits are already local-only.
 * Failures propagate raw — each surface names its own fallback message.
 */
export async function runSubmitForReviewFlow(
  target: PublishTarget,
  parts: PublishMessage,
): Promise<CreatedPullRequest> {
  await pushChanges(target, parts.message);
  return openPullRequest(target, parts);
}

/** What a publish failure means: the message to show, and the PR it left behind. */
interface PublishFailure {
  message: string;
  /** Set when the merge failed after the PR opened — the work is in that PR. */
  pullRequest: CreatedPullRequest | null;
}

/**
 * Read a failure. A merge that failed after the pull request opened names it,
 * so the caller can link to it and refresh its PR state; everything else is the
 * step's own message, or the generic fallback for a non-Error throw.
 */
export function describePublishFailure(
  error: unknown,
  t: TFunction,
): PublishFailure {
  if (error instanceof PublishStepError && error.step === "merge" && error.pr) {
    return {
      message: t("thread.publishDialog.mergeFailed", {
        prNumber: error.pr.number,
        message: error.message,
      }),
      pullRequest: error.pr,
    };
  }
  return {
    message:
      error instanceof Error
        ? error.message
        : t("thread.publishDialog.failedPublish"),
    pullRequest: null,
  };
}

/**
 * {@link describePublishFailure} plus the toast both surfaces raise for it.
 * `pullRequestOpened` tells the caller to refresh its PR state.
 */
export function reportPublishFailure(
  error: unknown,
  t: TFunction,
): { message: string; pullRequestOpened: boolean } {
  const failure = describePublishFailure(error, t);
  const pr = failure.pullRequest;
  if (pr) {
    toast.error(failure.message, {
      action: {
        label: t("thread.publishDialog.viewPr"),
        onClick: () => window.open(pr.htmlUrl, "_blank", "noopener,noreferrer"),
      },
    });
  }
  return { message: failure.message, pullRequestOpened: pr !== null };
}

/** Both surfaces confirm a review submission the same way: PR number + link. */
export function notifySubmittedForReview(
  pr: CreatedPullRequest,
  t: TFunction,
): void {
  toast.success(
    t("thread.publishDialog.submittedForReview", { prNumber: pr.number }),
    {
      action: {
        label: t("thread.publishDialog.viewOnGithub"),
        onClick: () => window.open(pr.htmlUrl, "_blank", "noopener,noreferrer"),
      },
    },
  );
}
