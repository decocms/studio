/**
 * The publish dialog's write side: one `submit` entry point that publishes or
 * submits for review depending on the mode, plus the two discard paths — and
 * the publish's in-flight/error state. The sequence itself is shared with the
 * sandbox runtime and lives in {@link ./publish-flow.ts}.
 *
 * On a v8 site every discard is a content change (content-sync.ts) over the
 * content protocol: `changes.discard` drops the entries back to the source's
 * base (main on GitHub, the last commit in a sandbox), in the editor's own
 * write queue, guarded by the versions the list showed. On a hosted v8 site
 * a publish or "Try again" refreshes the editor, the preview and the
 * releases the same way an edit does. v7 sites keep their git paths.
 */

import type { MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import {
  runContentChange,
  runContentDiscard,
} from "@/components/sections-editor/content-sync.ts";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync.ts";
import type { ProtocolBackend } from "@/components/sections-editor/content-backend.ts";
import {
  discardContentChanges,
  isChangedMeanwhile,
  isOutdatedServerError,
  readChangeSides,
} from "@/components/sections-editor/content-changes.ts";
import { rereadProtocolContent } from "@/components/sections-editor/content-protocol-api.ts";
import {
  type NamedRuleDiscardBreak,
  namedRuleDiscardBreaks,
} from "@/components/sections-editor/named-rule-discard.ts";
import {
  NAMED_RULE_KINDS,
  namedRuleSupport,
} from "@/components/sections-editor/named-rules.ts";
import { ContentProtocolError } from "@decocms/blocks/protocol";

/** A discard not sent: it would leave pages naming a missing test or campaign. */
class DiscardBlockedError extends Error {
  constructor(readonly breaks: NamedRuleDiscardBreak[]) {
    super("The discard would leave pages using a missing test or campaign");
    this.name = "DiscardBlockedError";
  }
}
import { KEYS } from "@/lib/query-keys.ts";
import { MAIN_SCHEMA_CHANGED } from "@decocms/shared/blocks-major";
import { resetMainSchemaAnswer } from "@/hooks/main-schema-changed";
import type { PublishChange } from "./publish-change-summary.ts";
import {
  describePublishFailure,
  notifySubmittedForReview,
  publishNoteParts,
  runPublishFlow,
  runSubmitForReviewFlow,
  type PublishTarget,
} from "./publish-flow.ts";
import { discardGitFiles } from "./sandbox-git-api.ts";
import {
  HostedPublishError,
  type HostedPublishResult,
  publishHostedDraft,
  retryRelease,
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
  /**
   * A v8 site: discards go through the content protocol (`changes.discard`)
   * on this backend, and "discard all" drops `entries`, every listed change.
   */
  protocol?: {
    backend: ProtocolBackend;
    entries: ReadonlyArray<{ name: string; version: string | null }>;
  };
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
  /**
   * A discard that would leave pages using a test or campaign that no longer
   * exists: nothing was discarded; the dialog lists them until closed.
   */
  discardBlocked: NamedRuleDiscardBreak[] | null;
  closeDiscardBlocked: () => void;
}

/**
 * A v8 discard (`changes.discard`): the entries go back to the source's
 * base (main on GitHub, the last commit in a sandbox or on Localhost), so the
 * editor and the preview show the base as it is now. It runs in the editor's
 * write queue (content-sync.ts `runContentDiscard`): armed autosaves of these
 * entries are dropped and the ones in flight land first; then the editor, the
 * preview and the lists refresh as after an edit. Each entry is guarded by
 * the version the list showed: one changed since (someone else's save) is a
 * Conflict, nothing is dropped, and the list shows what is there now. One
 * toast either way.
 *
 * A test or campaign a page uses never goes away (named-rule-discard.ts):
 * in the queue, right before the discard, the draft and both sides of those
 * changes are read again, and a discard that would leave a page naming one
 * that doesn't exist is not sent; `onBlocked` gets what it would break
 * instead (no error toast).
 */
export function useContentDiscard(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
  /** Re-reads the caller's list after a Conflict. */
  refresh: () => Promise<unknown>;
  /** The discard would break a test or campaign's pages: nothing was sent. */
  onBlocked: (breaks: NamedRuleDiscardBreak[]) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const content = useContentSyncTarget({
    orgSlug: args.orgSlug,
    virtualMcpId: args.virtualMcpId,
    branch: args.branch,
  });
  /**
   * What discarding `entries` would break, read fresh: the draft as stored
   * and both sides of those changes. A site whose schema has neither A/B
   * tests nor campaigns has none to break, so nothing more is read.
   */
  const discardBreaks = async (
    backend: ProtocolBackend,
    entries: ReadonlyArray<{ name: string; version: string | null }>,
  ): Promise<NamedRuleDiscardBreak[]> => {
    if (!content.cacheKey || !args.branch) return [];
    const current = await rereadProtocolContent(
      queryClient,
      backend,
      {
        orgSlug: args.orgSlug,
        virtualMcpId: args.virtualMcpId,
        branch: args.branch,
      },
      content.cacheKey,
    );
    const meta =
      current.meta instanceof ContentProtocolError ? null : current.meta;
    if (
      meta &&
      NAMED_RULE_KINDS.every(
        (kind) => namedRuleSupport(meta, kind) === "missing",
      )
    ) {
      return [];
    }
    const names = entries.map((entry) => entry.name);
    const sides = await readChangeSides(backend.client, names);
    return namedRuleDiscardBreaks({
      draft: current.blocks,
      sides: sides.entries,
      names,
      meta,
    });
  };

  return async (
    backend: ProtocolBackend,
    entries: ReadonlyArray<{ name: string; version: string | null }>,
    success: string,
  ): Promise<void> => {
    try {
      await runContentDiscard(content, {
        blockKeys: entries.map((entry) => entry.name),
        // The revision is not adopted (an edit's is): the editor holds no
        // copy of the base's blocks, so the refresh must read them, and a
        // poll conditional on this revision would answer "not modified".
        write: async () => {
          // In the queue, after the saves in flight landed: what is stored now.
          const breaks = await discardBreaks(backend, entries);
          if (breaks.length > 0) throw new DiscardBlockedError(breaks);
          return discardContentChanges(backend.client, entries);
        },
      });
      toast.success(success);
    } catch (error) {
      if (error instanceof DiscardBlockedError) {
        args.onBlocked(error.breaks);
        return;
      }
      if (isChangedMeanwhile(error)) {
        toast.info(t("siteEditor.discard.changedMeanwhile"));
        await args.refresh().catch(() => {});
        return;
      }
      // An older `deco serve` took its place: its probe says so.
      if (backend.source === "local" && isOutdatedServerError(error)) {
        void queryClient.resetQueries({
          queryKey: KEYS.contentBackend(
            args.orgSlug,
            args.virtualMcpId,
            "local",
          ),
        });
      }
      toast.error(t("siteEditor.discard.failed"), {
        description: errorDetailsDescription(t, errorDetail(error)),
      });
    }
  };
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
    protocol,
  } = args;
  const t = useT();
  const queryClient = useQueryClient();
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [publishErrorDetail, setPublishErrorDetail] = useState<string | null>(
    null,
  );
  const [discardBlocked, setDiscardBlocked] = useState<
    NamedRuleDiscardBreak[] | null
  >(null);

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

  /** "Try again": release the saved changes (main's head), same toast. */
  const retryPublish = async () => {
    try {
      await runContentChange(content, {
        kind: "publish",
        refreshOnError: true,
        write: () => retryRelease(target),
      });
      toastPublished(t);
    } catch (error) {
      notifySavedNotPublished(t, error, () => void retryPublish());
    }
  };

  /** Saved on main is done: the popover closes with one toast. */
  const settleHosted = async (result: HostedPublishResult) => {
    notifyHostedPublish(t, result, () => void retryPublish());
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

      toastPublished(t, destinationHost);
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

  const discardEntries = useContentDiscard({
    orgSlug: target.orgSlug,
    virtualMcpId: target.virtualMcpId,
    branch: target.branch,
    refresh,
    onBlocked: setDiscardBlocked,
  });

  /** A v7 discard: its git path, as before; only the pending state is shared. */
  const discardFiles = async (filepaths: string[], success: string) => {
    try {
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
          ),
      });
      toast.success(success);
      await refresh();
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
    discardBlocked,
    closeDiscardBlocked: () => setDiscardBlocked(null),
    // Hosted callers never pass review mode (no pull request to open).
    submit:
      mode === "review" ? submitForReview : hosted ? publishHosted : publish,
    discardChange: (change) => {
      const success = t("thread.publishPopover.discarded", {
        name: change.name,
      });
      return protocol && change.entry
        ? discardEntries(protocol.backend, [change.entry], success)
        : discardFiles(change.filepaths, success);
    },
    discardAll: async () => {
      const success = t("thread.publishDialog.allChangesDiscarded");
      if (protocol) {
        if (protocol.entries.length === 0) return;
        await discardEntries(protocol.backend, protocol.entries, success);
        return;
      }
      if (allPaths.length === 0) return;
      await discardFiles(allPaths, success);
    },
  };
}
