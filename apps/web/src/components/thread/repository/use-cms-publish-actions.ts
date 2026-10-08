/**
 * The publish dialog's write side: one `submit` entry point that publishes or
 * submits for review depending on the mode, plus the two discard paths — and
 * the in-flight/error state they own. The sequence itself is shared with the
 * sandbox runtime and lives in {@link ./publish-flow.ts}.
 */

import type { MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys.ts";
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
} from "./hosted-publish-api.ts";

/** `publish` merges to production; `review` stops at the pull request. */
export type CmsPublishMode = "publish" | "review";

interface CmsPublishActionsArgs {
  mode: CmsPublishMode;
  target: PublishTarget;
  /** The version note, authored in the dialog — title on line 1, body below. */
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
   * A hosted v8 site: publish commits the CDN draft to main, creates its
   * release and makes it current (no pull request). It's done once merged; a
   * release that isn't current is made current from the Releases screen.
   */
  hosted?: boolean;
}

interface CmsPublishActions {
  isPublishing: boolean;
  isDiscarding: boolean;
  publishError: string | undefined;
  /** Publish or submit for review, per mode — the button never branches. */
  submit: () => Promise<void>;
  discardChange: (change: PublishChange) => Promise<void>;
  discardAll: () => Promise<void>;
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
  const queryClient = useQueryClient();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [publishError, setPublishError] = useState<string>();

  const noteParts = () =>
    publishNoteParts(
      note,
      t("thread.publishDialog.changesFrom", { branch: target.headBranch }),
    );

  /** Merged is done: the popover closes, saying what the CDN serves. */
  const settleHosted = async (result: HostedPublishResult) => {
    if (result.result === "up-to-date") {
      toast.success(t("thread.publishPopover.upToDate"));
    } else if (result.release === "current") {
      toast.success(t("thread.publishPopover.mergedCurrent"));
    } else if (result.release === "created") {
      toast.warning(t("thread.publishPopover.mergedNotCurrent"));
    } else {
      toast.warning(t("thread.publishPopover.mergedNoRelease"));
    }
    // A mounted Releases screen shows the new commit and what is Current.
    void queryClient.invalidateQueries({
      queryKey: KEYS.hostedReleases(target.orgSlug, target.virtualMcpId),
    });
    onOpenChange(false);
    await onPublished?.();
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
        target.fastPreview ? { fastPreview: true } : undefined,
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
    // Hosted callers never pass review mode (no pull request to open).
    submit:
      mode === "review" ? submitForReview : hosted ? publishHosted : publish,
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
