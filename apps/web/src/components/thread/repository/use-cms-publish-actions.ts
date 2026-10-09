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
  type HostedPublishResult,
  publishHostedDraft,
  publishMainHead,
} from "./hosted-publish-api.ts";
import {
  hostedPublishFailure,
  notifyHostedPublish,
  notifySavedNotPublished,
} from "./hosted-publish-feedback.ts";
import {
  errorDetail,
  errorDetailsDescription,
  toastPublished,
} from "@/components/sections-editor/site-editor-toast.tsx";

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
   * release and makes it current (no pull request). Saved once on main; when
   * it isn't live yet, the toast's "Try again" makes main's head live.
   */
  hosted?: boolean;
  /** Who publishes: a hosted Publish's default version note names them. */
  authorName?: string | null;
}

interface CmsPublishActions {
  isPublishing: boolean;
  isDiscarding: boolean;
  publishError: string | undefined;
  /** The developer detail behind `publishError`, for a Details disclosure. */
  publishErrorDetail: string | null;
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
    authorName,
  } = args;
  const t = useT();
  const queryClient = useQueryClient();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [publishErrorDetail, setPublishErrorDetail] = useState<string | null>(
    null,
  );

  const noteParts = () =>
    publishNoteParts(
      note,
      // A hosted site's notes are the Versions screen's titles: never a
      // branch name there.
      hosted
        ? authorName
          ? t("siteEditor.publish.defaultNote", { name: authorName })
          : t("siteEditor.publish.defaultNoteAnonymous")
        : t("thread.publishDialog.changesFrom", { branch: target.headBranch }),
    );

  const invalidateVersions = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostedReleases(target.orgSlug, target.virtualMcpId),
    });

  /** "Try again": put the saved changes live (main's head), same toast. */
  const goLive = async () => {
    try {
      await publishMainHead(target);
      toastPublished(t, t("siteEditor.publish.changesLive"));
    } catch (error) {
      notifySavedNotPublished(t, error, () => void goLive());
    } finally {
      void invalidateVersions();
    }
  };

  /** Saved on main is done: the popover closes with one toast. */
  const settleHosted = async (result: HostedPublishResult) => {
    notifyHostedPublish(t, result, () => void goLive());
    // A mounted Versions screen shows the new version and what is live.
    void invalidateVersions();
    onOpenChange(false);
    await onPublished?.();
  };

  const publishHosted = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    setPublishErrorDetail(null);
    try {
      await settleHosted(await publishHostedDraft(target, noteParts().message));
    } catch (error) {
      const failure = hostedPublishFailure(t, error);
      setPublishError(failure.message);
      setPublishErrorDetail(failure.detail);
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
    setPublishErrorDetail(null);
    try {
      await runPublishFlow(target, noteParts(), t);

      toastPublished(
        t,
        destinationHost
          ? t("siteEditor.publish.liveOn", { host: destinationHost })
          : t("siteEditor.publish.changesLive"),
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
    setPublishErrorDetail(null);
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
      toast.error(t("siteEditor.discard.failed"), {
        description: errorDetailsDescription(t, errorDetail(error)),
      });
    } finally {
      setIsDiscarding(false);
    }
  };

  return {
    isPublishing,
    isDiscarding,
    publishError,
    publishErrorDetail,
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
