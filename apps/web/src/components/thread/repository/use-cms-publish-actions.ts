/**
 * The publish dialog's write side: one `submit` entry point that publishes or
 * submits for review depending on the mode, plus the two discard paths — and
 * the publish's in-flight/error state. The sequence itself is shared with the
 * sandbox runtime and lives in {@link ./publish-flow.ts}.
 *
 * On a hosted v8 site every write here is a content change (content-sync.ts):
 * a discard writes main's version back through `blocks.apply` (read when it
 * runs, in the editor's own write queue), and a publish
 * or "Try again" refreshes the editor, the preview and the releases the same
 * way an edit does. The other sites keep their git paths.
 */

import type { MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { protocolApply } from "@/components/sections-editor/content-protocol-api.ts";
import {
  runContentChange,
  runContentDiscard,
} from "@/components/sections-editor/content-sync.ts";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync.ts";
import { discardPlan } from "./discard-patch.ts";
import { MAIN_SCHEMA_CHANGED } from "@decocms/shared/blocks-major";
import { resetMainSchemaAnswer } from "@/hooks/main-schema-changed";
import {
  blockKeyFromDiffPath,
  type PublishChange,
} from "./publish-change-summary.ts";
import {
  describePublishFailure,
  notifySubmittedForReview,
  publishNoteParts,
  runPublishFlow,
  runSubmitForReviewFlow,
  type PublishTarget,
} from "./publish-flow.ts";
import { discardGitFiles, fetchGitDiff } from "./sandbox-git-api.ts";
import {
  HostedPublishError,
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
  const [publishError, setPublishError] = useState<string>();
  const [publishErrorDetail, setPublishErrorDetail] = useState<string | null>(
    null,
  );

  const noteParts = () =>
    publishNoteParts(
      note,
      // A hosted site's notes are the Releases screen's titles: never a
      // branch name there.
      hosted
        ? authorName
          ? t("siteEditor.publish.defaultNote", { name: authorName })
          : t("siteEditor.publish.defaultNoteAnonymous")
        : t("thread.publishDialog.changesFrom", { branch: target.headBranch }),
    );

  /** A follow-up after a finished Publish: its failure isn't the Publish's. */
  const quietly = async (followUp?: () => void | Promise<void>) => {
    try {
      await followUp?.();
    } catch {
      // The Publish already succeeded (and said so); a stale list re-reads.
    }
  };

  const content = useContentSyncTarget({
    orgSlug: target.orgSlug,
    virtualMcpId: target.virtualMcpId,
    branch: target.branch,
  });

  /** "Try again": put the saved changes live (main's head), same toast. */
  const goLive = async () => {
    try {
      await runContentChange(content, {
        kind: "publish",
        refreshOnError: true,
        write: () => publishMainHead(target),
      });
      toastPublished(t, t("siteEditor.publish.changesLive"));
    } catch (error) {
      notifySavedNotPublished(t, error, () => void goLive());
    }
  };

  /** Saved on main is done: the popover closes with one toast. */
  const settleHosted = async (result: HostedPublishResult) => {
    notifyHostedPublish(t, result, () => void goLive());
    onOpenChange(false);
    await quietly(onPublished);
  };

  const publishHosted = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    setPublishErrorDetail(null);
    try {
      // A content change like any other: the editor, the preview and the
      // releases catch up; on a failure too, since it may have saved.
      const result = await runContentChange(content, {
        kind: "publish",
        reread: true,
        refreshOnError: true,
        write: () => publishHostedDraft(target, noteParts().message),
      });
      await settleHosted(result);
    } catch (error) {
      // Main is no longer v8: the editor goes back to waiting and decides
      // again on main's new answer.
      if (
        error instanceof HostedPublishError &&
        error.code === MAIN_SCHEMA_CHANGED
      ) {
        resetMainSchemaAnswer(queryClient, target.orgSlug, target.virtualMcpId);
      }
      const failure = hostedPublishFailure(t, error);
      setPublishError(failure.message);
      setPublishErrorDetail(failure.detail);
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
      await Promise.all([quietly(onPullRequestChanged), quietly(onPublished)]);
    } catch (error) {
      // One message in the dialog, in plain words (no toast on top of it);
      // the step's own error, and the pull request a failed merge left
      // open, go behind Details.
      const failure = describePublishFailure(error, t);
      setPublishError(
        failure.headMoved ? failure.message : t("siteEditor.publish.failed"),
      );
      setPublishErrorDetail(
        failure.headMoved
          ? null
          : [
              failure.pullRequest
                ? `#${failure.pullRequest.number} ${failure.pullRequest.htmlUrl}`
                : null,
              errorDetail(error),
            ]
              .filter(Boolean)
              .join("\n") || null,
      );
      if (failure.pullRequest) await quietly(onPullRequestChanged);
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
      const failure = describePublishFailure(error, t);
      setPublishError(
        failure.message || t("thread.publishDialog.failedSubmitForReview"),
      );
      if (failure.headMoved) await refresh();
    } finally {
      publishLockRef.current = false;
      setIsPublishing(false);
    }
  };

  /**
   * A hosted v8 discard writes main's version back (`blocks.apply`). It runs
   * in the editor's write queue (content-sync.ts `runContentDiscard`): armed
   * autosaves of these blocks are dropped and the ones in flight land first.
   * Then main's version is read (one fresh diff; main may have moved since
   * the dialog loaded, and the in-flight saves are in it now): a block that
   * still differs gets main's body back, one that already equals main only
   * loses its draft entry. Without that read it asks the server to drop the
   * draft's entries. Either way the editor, the preview and this list refresh
   * as after an edit.
   */
  const discardHosted = (filepaths: string[]) => {
    const backend = content.backend;
    const call = { fastPreview: true };
    return runContentDiscard(content, {
      blockKeys: filepaths.flatMap((path) => blockKeyFromDiffPath(path) ?? []),
      write: async () => {
        const main =
          backend?.kind === "protocol"
            ? await fetchGitDiff(
                target,
                { base: target.baseBranch },
                call,
              ).catch(() => null)
            : null;
        const plan = discardPlan(filepaths, main);
        if (!plan || backend?.kind !== "protocol") {
          await discardGitFiles(target, filepaths, call);
          return { reread: true };
        }
        if (plan.patch) {
          await protocolApply(
            queryClient,
            backend,
            target,
            content.cacheKey ?? "",
            plan.patch,
          );
        }
        if (plan.drop.length > 0) {
          await discardGitFiles(target, plan.drop, call);
        }
        return {
          patch: plan.patch ?? undefined,
          reread: plan.drop.length > 0,
        };
      },
      outcome: (refresh) => refresh,
    });
  };

  const discardFiles = async (filepaths: string[], success: string) => {
    try {
      if (hosted) {
        await discardHosted(filepaths);
      } else {
        // Its git path, as before; only the pending state is shared. A v8
        // sandbox also re-reads its blocks before the open form re-reads its
        // block (v7 refreshes the way it always has: `reread` is ignored).
        await runContentChange(content, {
          kind: "discard",
          reread: true,
          write: () =>
            discardGitFiles(
              {
                orgSlug: target.orgSlug,
                virtualMcpId: target.virtualMcpId,
                branch: target.branch,
                threadId: target.threadId,
              },
              filepaths,
              target.fastPreview ? { fastPreview: true } : undefined,
            ),
        });
      }
      toast.success(success);
      if (!hosted) await refresh();
    } catch (error) {
      toast.error(t("siteEditor.discard.failed"), {
        description: errorDetailsDescription(t, errorDetail(error)),
      });
    }
  };

  return {
    isPublishing,
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
