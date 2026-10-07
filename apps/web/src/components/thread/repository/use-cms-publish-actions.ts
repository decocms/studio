/**
 * The publish popover's write side: one `submit` entry point that publishes or
 * submits for review depending on the mode, plus the two discard paths — and
 * the in-flight/error state they own. The sequence itself is shared with the
 * coding session's dialog and lives in {@link ./publish-flow.ts}.
 */

import type { MutableRefObject } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import type { PublishChange } from "./publish-change-summary.ts";
import {
  notifySubmittedForReview,
  publishNoteParts,
  reportPublishFailure,
  runPublishFlow,
  runSubmitForReviewFlow,
  type PublishTarget,
} from "./publish-flow.ts";
import { discardGitFiles } from "./sandbox-git-api.ts";
import {
  HostedPublishError,
  type HostedPublishResult,
  publishHostedDraft,
  resyncHosted,
} from "./hosted-publish-api.ts";

/** `publish` merges to production; `review` stops at the pull request. */
export type CmsPublishMode = "publish" | "review";

interface CmsPublishActionsArgs {
  mode: CmsPublishMode;
  target: PublishTarget;
  /** The version note, authored in the popover — title on line 1, body below. */
  note: string;
  /** Every changed path, from the manifest — what "discard all" reverts. */
  allPaths: string[];
  /** Named in the success toast when publishing goes to a custom domain. */
  destinationHost: string | null;
  /** Held while a flow runs, so an outside click can't dismiss its progress. */
  publishLockRef: MutableRefObject<boolean>;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<unknown>;
  onPullRequestChanged?: () => void | Promise<void>;
  onPublished?: () => void | Promise<void>;
  /**
   * A hosted v8 site: publish commits the CDN draft to main and releases it
   * (no pull request); a release that didn't go live yet offers Resync.
   */
  hosted?: boolean;
}

/** A hosted publish landed in git but isn't live yet; Resync releases main. */
interface HostedPending {
  /** Resync would override a rollback: the next resync must confirm. */
  needsConfirm: boolean;
  isResyncing: boolean;
  resync: () => Promise<void>;
}

interface CmsPublishActions {
  isPublishing: boolean;
  isDiscarding: boolean;
  publishError: string | undefined;
  /** Publish or submit for review, per mode — the button never branches. */
  submit: () => Promise<void>;
  discardChange: (change: PublishChange) => Promise<void>;
  discardAll: () => Promise<void>;
  /** Set while a hosted publish is pending (see {@link HostedPending}). */
  hostedPending: HostedPending | null;
}

export function useCmsPublishActions(
  args: CmsPublishActionsArgs,
): CmsPublishActions {
  const {
    mode,
    target,
    note,
    allPaths,
    destinationHost,
    publishLockRef,
    onOpenChange,
    refresh,
    onPullRequestChanged,
    onPublished,
    hosted = false,
  } = args;
  const t = useT();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);

  const noteParts = () =>
    publishNoteParts(
      note,
      t("thread.publishDialog.changesFrom", { branch: target.headBranch }),
    );

  const published = async () => {
    toast.success(
      destinationHost
        ? t("thread.publishPopover.publishedTo", { host: destinationHost })
        : t("thread.publishDialog.publishedTo", {
            baseBranch: target.baseBranch,
          }),
    );
    onOpenChange(false);
    await onPublished?.();
  };

  /** A hosted release that went live closes; one that didn't stays open. */
  const settleHosted = async (result: HostedPublishResult) => {
    if (result.result === "pending") {
      setPending(true);
      setPublishError(t("thread.publishPopover.hostedPending"));
      await refresh();
      return;
    }
    setPending(false);
    setNeedsConfirm(false);
    await published();
  };

  const publishHosted = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    try {
      await settleHosted(await publishHostedDraft(target, noteParts().message));
    } catch (error) {
      setPublishError(
        error instanceof HostedPublishError && error.code === "main-moved"
          ? t("thread.publishPopover.mainMoved")
          : error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedPublish"),
      );
      await refresh();
    } finally {
      publishLockRef.current = false;
      setIsPublishing(false);
    }
  };

  const resync = async () => {
    setIsResyncing(true);
    try {
      await settleHosted(await resyncHosted(target, needsConfirm));
    } catch (error) {
      if (error instanceof HostedPublishError && error.code === "rolled-back") {
        setNeedsConfirm(true);
        setPublishError(t("thread.publishPopover.resyncOverridesRollback"));
        return;
      }
      setPublishError(
        error instanceof Error
          ? error.message
          : t("thread.publishDialog.failedPublish"),
      );
    } finally {
      setIsResyncing(false);
    }
  };

  const publish = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    try {
      await runPublishFlow(target, noteParts(), t);

      toast.success(
        destinationHost
          ? t("thread.publishPopover.publishedTo", { host: destinationHost })
          : t("thread.publishDialog.publishedTo", {
              baseBranch: target.baseBranch,
            }),
      );
      onOpenChange(false);
      // Together: awaiting the PR re-read first let the stale open PR render.
      await Promise.all([onPullRequestChanged?.(), onPublished?.()]);
    } catch (error) {
      const failure = reportPublishFailure(error, t);
      setPublishError(failure.message);
      if (failure.pullRequestOpened) await onPullRequestChanged?.();
      // Nothing was published — re-read so the list matches the new head.
      if (failure.headMoved) await refresh();
    } finally {
      publishLockRef.current = false;
      setIsPublishing(false);
    }
  };

  const submitForReview = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    try {
      const pr = await runSubmitForReviewFlow(target, noteParts());

      notifySubmittedForReview(pr, t);
      onOpenChange(false);
      await onPullRequestChanged?.();
    } catch (error) {
      const failure = reportPublishFailure(error, t);
      setPublishError(
        failure.message || t("thread.publishDialog.failedSubmitForReview"),
      );
      if (failure.headMoved) await refresh();
    } finally {
      publishLockRef.current = false;
      setIsPublishing(false);
    }
  };

  const discardFiles = async (filepaths: string[], success: string) => {
    setIsDiscarding(true);
    try {
      await discardGitFiles(
        {
          orgSlug: target.orgSlug,
          virtualMcpId: target.virtualMcpId,
          branch: target.branch,
          threadId: target.threadId,
        },
        filepaths,
        { fastPreview: true },
      );
      toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("thread.publishPopover.failedDiscard"),
      );
    } finally {
      setIsDiscarding(false);
    }
  };

  return {
    isPublishing,
    isDiscarding,
    publishError,
    // OPEN: review mode (submit for review) has no hosted equivalent: the
    // draft is not a branch, so there is no pull request to open.
    submit:
      mode === "review" ? submitForReview : hosted ? publishHosted : publish,
    hostedPending: pending ? { needsConfirm, isResyncing, resync } : null,
    discardChange: (change) =>
      discardFiles(
        change.filepaths,
        t("thread.publishPopover.discarded", { name: change.name }),
      ),
    discardAll: async () => {
      if (allPaths.length === 0) return;
      await discardFiles(
        allPaths,
        t("thread.publishDialog.allChangesDiscarded"),
      );
    },
  };
}
