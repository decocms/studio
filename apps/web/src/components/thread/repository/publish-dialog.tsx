/**
 * The shared content-first publish surface — presentation only: reads come
 * from {@link useCmsPublishState}, writes from {@link useCmsPublishActions}.
 * Loads in two beats — see {@link useCmsPublishState} for what each decides.
 */

import type { RepoToolTarget } from "@/lib/repository-binding.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AlertTriangle,
  CheckCircle,
  Eye,
  GitPullRequest,
  Globe01,
  RefreshCw01,
} from "@untitledui/icons";
import { Suspense, useRef, useState, type ReactNode } from "react";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
} from "@/components/sandbox/preview/last-preview-page.ts";
import { changeId, PublishChangeCard } from "./cms-publish-change-card.tsx";
import { PublishCompare } from "./cms-publish-compare.tsx";
import type { CompareDraft } from "./cms-publish-compare-path.ts";
import {
  PublishFrame,
  PublishGhost,
  PublishGhostCard,
  PublishListRegion,
  type PublishSurfaceState,
} from "./cms-publish-frame.tsx";
import { lastPublishAttribution } from "./pr-attribution.ts";
import {
  buildAutoNote,
  resolveVersionNote,
  type PublishChange,
} from "./publish-change-summary.ts";
import type { PublishTarget } from "./publish-flow.ts";
import {
  readGitHeadBranch,
  reviewDiffSignature,
  type PublishPolicy,
} from "./sandbox-git-api.ts";
import type { PrSummary } from "./use-pr-data.ts";
import {
  useCmsPublishActions,
  type CmsPublishMode,
} from "./use-cms-publish-actions.ts";
import { useCmsPublishState } from "./use-cms-publish-state.ts";
import { useResolvedPublishGate } from "@/components/sandbox/hooks/use-publish-gate.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useContentBackend } from "@/components/sections-editor/use-content-backend.ts";

export type { CmsPublishMode };

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Defaults to `publish`; see the module doc for what each mode runs. */
  mode?: CmsPublishMode;
  /** Sandbox-less Fast Preview; otherwise a coding session's sandbox answers. */
  fastPreview: boolean;
  /** Re-provisions a coding session's sandbox when it stops answering. */
  recoverSandbox?: () => Promise<unknown>;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  baseBranch: string;
  /** Which repository this publishes to, and which credential writes it. */
  repoTarget: RepoToolTarget;
  owner: string;
  repo: string;
  publishPolicy: PublishPolicy;
  /** Where Preview opens: Fast Preview's draft URL, or the sandbox preview. */
  draftPreviewUrl: string | null;
  destinationHost: string | null;
  /** Live site origin the review pane renders each changed page against. */
  previewServerUrl: string | null;
  /** Where the review pane renders the changes; see {@link CompareDraft}. */
  compareDraft: CompareDraft | null;
  /** The last publish, warmed by the header — never blocks this surface. */
  lastPublishedPr?: PrSummary | null;
  /** Blocked gate: hand this surface over to review mode. */
  onRequestApproval: () => void;
  /** When set, publish updates this open PR instead of opening a new one. */
  openPullRequest?: PrSummary | null;
  onPullRequestChanged?: () => void | Promise<void>;
  onPublished?: () => void | Promise<void>;
}

export function PublishDialog(props: PublishDialogProps) {
  /** Set by the body while the publish flow runs — an outside click or Escape
   *  must not dismiss the only surface showing that progress. */
  const publishLockRef = useRef(false);
  const t = useT();

  const handleOpenChange = (next: boolean) => {
    if (!next && publishLockRef.current) return;
    props.onOpenChange(next);
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col md:flex-row md:h-[calc(100dvh-6rem)] md:w-[calc(100vw-6rem)] gap-0 overflow-hidden p-0 sm:max-w-none"
        closeButtonClassName="top-3.5 right-3.5"
      >
        <DialogTitle className="sr-only">
          {props.mode === "review"
            ? t("thread.publishPopover.submitForReview")
            : t("thread.publishPopover.publish")}
        </DialogTitle>
        {props.open ? (
          <CmsPublishBody {...props} publishLockRef={publishLockRef} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Only these bases are production; publishing elsewhere is not "in production". */
function isProductionBranch(base: string): boolean {
  return ["main", "master"].includes(base.trim().toLowerCase());
}

/** Review panes kept alive at once — each holds up to two full-page frames. */
const MAX_LIVE_PANES = 4;

/** Above the list on narrow screens, beside it from `md` up. */
const REVIEW_PANE = "flex h-[45%] min-h-0 min-w-0 shrink-0 md:h-auto md:flex-1";

/** The review pane beside the list column, whose header clears the close button. */
function ReviewLayout({ list, pane }: { list: ReactNode; pane: ReactNode }) {
  return (
    <>
      {pane}
      <div className="flex min-h-0 w-full flex-1 flex-col max-md:border-t md:w-[380px] md:flex-none md:shrink-0 md:border-l md:[&>[data-publish-state]>:first-child]:pr-12">
        {list}
      </div>
    </>
  );
}

function ReviewPaneGhost() {
  return (
    <div className={cn(REVIEW_PANE, "bg-muted/40 p-3")}>
      <PublishGhost className="h-full w-full rounded-lg" />
    </div>
  );
}

function HeaderLine({
  mode,
  title,
  subLine,
  trailing,
}: {
  mode: CmsPublishMode;
  title: ReactNode;
  subLine?: ReactNode;
  trailing?: ReactNode;
}) {
  const Icon = mode === "review" ? GitPullRequest : Globe01;
  return (
    <>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {title}
        {trailing}
      </div>
      {subLine ? (
        <div className="pl-6 text-xs text-muted-foreground">{subLine}</div>
      ) : null}
    </>
  );
}

/** Preview always works: its URL is a prop, settled before this surface opened. */
function PreviewButton({
  draftPreviewUrl,
  t,
}: {
  draftPreviewUrl: string | null;
  t: TFunction;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        if (draftPreviewUrl) {
          window.open(draftPreviewUrl, "_blank", "noopener,noreferrer");
        }
      }}
      disabled={!draftPreviewUrl}
    >
      <Eye className="size-4" />
      {t("thread.publishPopover.preview")}
    </Button>
  );
}

function CmsPublishSkeleton({
  mode,
  draftPreviewUrl,
}: {
  mode: CmsPublishMode;
  draftPreviewUrl: string | null;
}) {
  const t = useT();
  return (
    <ReviewLayout
      pane={<ReviewPaneGhost />}
      list={
        <PublishFrame
          state="loading"
          header={
            <HeaderLine
              mode={mode}
              title={<PublishGhost className="h-3.5 w-48" />}
            />
          }
          body={
            <PublishListRegion>
              <div className="space-y-1.5">
                <PublishGhostCard />
                <PublishGhostCard />
                <PublishGhostCard />
              </div>
            </PublishListRegion>
          }
          note={
            <>
              <PublishGhost className="h-3 w-20" />
              <PublishGhost className="h-14 w-full rounded-lg" />
            </>
          }
          footer={
            <div className="flex gap-2">
              <PreviewButton draftPreviewUrl={draftPreviewUrl} t={t} />
              <Button
                type="button"
                variant={mode === "review" ? "default" : "brand"}
                className="flex-1"
                disabled
              >
                {mode === "review"
                  ? t("thread.publishPopover.submitForReview")
                  : t("thread.publishPopover.publish")}
              </Button>
            </div>
          }
        />
      }
    />
  );
}

function CmsPublishLoadError({
  mode,
  draftPreviewUrl,
  message,
  onRetry,
}: {
  mode: CmsPublishMode;
  draftPreviewUrl: string | null;
  message: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <ReviewLayout
      pane={<div className={cn(REVIEW_PANE, "bg-muted/40")} />}
      list={
        <PublishFrame
          state="ready"
          header={
            <HeaderLine
              mode={mode}
              title={
                <span className="truncate">
                  {t("thread.publishPopover.loadFailed")}
                </span>
              }
            />
          }
          body={<p className="px-4 py-6 text-xs text-destructive">{message}</p>}
          footer={
            <div className="flex gap-2">
              <PreviewButton draftPreviewUrl={draftPreviewUrl} t={t} />
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={onRetry}
              >
                <RefreshCw01 className="size-4" />
                {t("thread.publishPopover.retry")}
              </Button>
            </div>
          }
        />
      }
    />
  );
}

function CmsPublishBody(
  props: PublishDialogProps & {
    publishLockRef: React.MutableRefObject<boolean>;
  },
) {
  const mode = props.mode ?? "publish";
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <CmsPublishLoadError
              mode={mode}
              draftPreviewUrl={props.draftPreviewUrl}
              message={error?.message ?? ""}
              onRetry={() => {
                reset();
                resetError();
              }}
            />
          )}
        >
          <Suspense
            fallback={
              <CmsPublishSkeleton
                mode={mode}
                draftPreviewUrl={props.draftPreviewUrl}
              />
            }
          >
            <CmsPublishContent {...props} />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function CmsPublishContent({
  publishLockRef,
  onOpenChange,
  mode = "publish",
  fastPreview,
  recoverSandbox,
  orgSlug,
  virtualMcpId,
  branch,
  baseBranch,
  repoTarget,
  owner,
  repo,
  publishPolicy,
  draftPreviewUrl,
  destinationHost,
  previewServerUrl,
  compareDraft,
  lastPublishedPr = null,
  onRequestApproval,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
}: PublishDialogProps & {
  publishLockRef: React.MutableRefObject<boolean>;
}) {
  const t = useT();
  /** The session publishing — the git routes resolve their runtime from it. */
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const { data: session } = authClient.useSession();

  /** Fills a dynamic page's `:param`s when it is the page last previewed. */
  const lastPreviewPage = readLastPreviewPage(
    lastPreviewPageKey(orgSlug, virtualMcpId, branch),
  );

  const {
    status: gitStatus,
    summary,
    allPaths,
    discardablePaths,
    changedFilesTotal,
    changedFilesTruncated,
    headSha,
    diff: gitDiff,
    bodiesPending,
    bodiesFailed,
    cardsPending,
    refresh,
  } = useCmsPublishState({
    orgSlug,
    virtualMcpId,
    branch,
    threadId,
    baseBranch,
    fastPreview,
    recoverSandbox,
  });

  /** The author's text once they type — until then the note is derived, so a
   *  change list that lands after mount still describes itself. */
  const [editedNote, setEditedNote] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  /** The card shown in the review pane. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Cards visited, most recent first — their panes stay mounted. */
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  const select = (id: string) => {
    setActiveId(id);
    setVisitedIds((current) => [id, ...current.filter((v) => v !== id)]);
  };
  /** Only one card may arm its discard at a time — it is a one-click destroy. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const note = resolveVersionNote(editedNote, buildAutoNote(summary));
  const changes = [...summary.pages, ...summary.blocks, ...summary.other];
  /** Falls back to the first change, so a discard never leaves the pane blank. */
  const selected =
    changes.find((change) => changeId(change) === activeId) ??
    changes[0] ??
    null;
  const selectedId = selected ? changeId(selected) : null;
  /** The selected pane, the recently visited ones, then the next in the list —
   *  mounted (hidden) so switching cards never waits on a page load again. */
  const liveIds = [
    ...new Set([
      ...(selectedId ? [selectedId] : []),
      ...visitedIds,
      ...changes.map(changeId),
    ]),
  ]
    .filter((id) => changes.some((change) => changeId(change) === id))
    .slice(0, MAX_LIVE_PANES);
  const backend = useContentBackend(virtualMcpId, branch);
  const hosted = backend.kind === "protocol" && backend.source === "github";
  // A hosted v8 draft has no pull request: review mode doesn't apply to it.
  const isReview = mode === "review" && !hosted;
  const surfaceState: PublishSurfaceState = cardsPending
    ? "loading"
    : bodiesPending
      ? "manifest"
      : "ready";

  // Submitting for review IS the escalation the gate asks for — never judge it.
  const { gate } = useResolvedPublishGate({
    orgSlug,
    virtualMcpId,
    branch,
    threadId,
    fastPreview,
    status: gitStatus,
    diff: gitDiff,
    paths: allPaths,
    policy: publishPolicy,
    judgeEnabled: !isReview,
  });

  const commitToOpenPr = openPullRequest?.state === "open";
  const target: PublishTarget = {
    orgSlug,
    virtualMcpId,
    branch,
    threadId,
    fastPreview,
    baseBranch,
    target: repoTarget,
    owner,
    repo,
    headBranch: readGitHeadBranch(gitStatus) ?? branch,
    coAuthor: coAuthorFromSessionUser(session?.user),
    expectedHeadSha: headSha ?? undefined,
    ...(!fastPreview && gitDiff
      ? { expectedDiffSignature: reviewDiffSignature(gitDiff) }
      : {}),
  };

  const {
    isPublishing,
    isDiscarding,
    publishError,
    submit,
    discardChange,
    discardAll,
  } = useCmsPublishActions({
    mode: isReview ? "review" : "publish",
    target,
    note,
    allPaths,
    destinationHost,
    publishLockRef,
    onOpenChange,
    refresh,
    onPullRequestChanged,
    onPublished,
    hosted,
  });

  const canDiscard = (paths: readonly string[]) =>
    discardablePaths === null || paths.every((p) => discardablePaths.has(p));

  const canSubmit =
    !isPublishing && summary.count > 0 && (isReview || gate.allowed);

  const headerTitle = isReview
    ? summary.count === 0
      ? t("thread.publishPopover.submitForReview")
      : summary.count === 1
        ? t("thread.publishPopover.submitOneForReview")
        : t("thread.publishPopover.submitCountForReview", {
            count: summary.count,
          })
    : summary.count === 0
      ? t("thread.publishPopover.publish")
      : !isProductionBranch(baseBranch)
        ? summary.count === 1
          ? t("thread.publishPopover.publishOne")
          : t("thread.publishPopover.publishCount", { count: summary.count })
        : summary.count === 1
          ? t("thread.publishPopover.publishOneInProduction")
          : t("thread.publishPopover.publishCountInProduction", {
              count: summary.count,
            });

  /** Review mode names the PR it will update; publish mode, the last release. */
  const subLine = (() => {
    if (isReview && commitToOpenPr) {
      return t("thread.publishPopover.updatesPullRequest", {
        number: openPullRequest.number,
      });
    }
    const pr = lastPublishedPr;
    if (!pr?.mergedAt) return null;
    const when = formatTimeAgo(new Date(pr.mergedAt));
    const name = lastPublishAttribution(pr);
    return name
      ? t("thread.publishPopover.lastPublishedBy", { when, name })
      : t("thread.publishPopover.lastPublished", { when });
  })();

  const primaryLabel = isReview
    ? t("thread.publishPopover.submitForReview")
    : summary.count === 1
      ? t("thread.publishPopover.publishOne")
      : summary.count > 1
        ? t("thread.publishPopover.publishCount", { count: summary.count })
        : t("thread.publishPopover.publish");

  const renderGroup = (label: string, changes: PublishChange[]) => {
    if (changes.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <div className="px-0.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </div>
        {changes.map((change) => {
          const id = changeId(change);
          return (
            <PublishChangeCard
              key={id}
              change={change}
              bodyPending={bodiesPending}
              selected={selected !== null && changeId(selected) === id}
              onSelect={() => select(id)}
              confirming={confirmingId === id}
              onConfirmingChange={(confirming) =>
                setConfirmingId(confirming ? id : null)
              }
              onDiscard={
                canDiscard(change.filepaths)
                  ? () => void discardChange(change)
                  : undefined
              }
              isPublishing={isPublishing}
              isDiscarding={isDiscarding}
            />
          );
        })}
      </div>
    );
  };

  const gateRow = (() => {
    if (isReview || summary.count === 0) return null;
    if (gate.pending) {
      return (
        <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <Spinner className="size-3.5 motion-reduce:animate-none" />
          {t("thread.publishPopover.reviewing")}
        </div>
      );
    }
    // Allowed → no row: content-only diffs never ran the judge, so stay silent.
    if (gate.allowed) return null;
    return (
      <div className="flex items-start gap-2 border-t px-4 py-2.5 text-xs text-warning">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {gate.reason ?? t("thread.publishPopover.needsReviewGeneric")}
        </span>
      </div>
    );
  })();

  // Never offer an all-files action over a set the server truncated.
  const discardAllControl =
    summary.count <= 1 ||
    changedFilesTruncated ||
    !canDiscard(allPaths) ? null : (
      <>
        <button
          type="button"
          className="ml-auto shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
          onClick={() => setDiscardAllConfirm(true)}
          disabled={isPublishing || isDiscarding}
        >
          {t("thread.publishPopover.discardAll")}
        </button>
        <AlertDialog
          open={discardAllConfirm}
          onOpenChange={setDiscardAllConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("thread.publishPopover.discardAllTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("thread.publishPopover.discardAllConfirm")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("thread.publishDialog.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void discardAll()}
                disabled={isDiscarding}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("thread.publishPopover.discardAll")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );

  const body = cardsPending ? (
    <PublishListRegion>
      <div className="space-y-1.5">
        <PublishGhostCard />
        <PublishGhostCard />
      </div>
    </PublishListRegion>
  ) : summary.count === 0 ? (
    <div className="flex flex-col items-center gap-1 py-10 text-center">
      <CheckCircle className="mb-1 size-5 text-success" />
      <p className="text-sm font-medium">
        {isReview
          ? t("thread.publishPopover.nothingToSubmit")
          : t("thread.publishPopover.everythingLive")}
      </p>
      <p className="text-xs text-muted-foreground">
        {isReview
          ? t("thread.publishPopover.submitEmptyHint")
          : t("thread.publishPopover.emptyHint")}
      </p>
    </div>
  ) : (
    <PublishListRegion>
      {changedFilesTruncated ? (
        <p className="text-[11px] text-muted-foreground">
          {t("thread.publishPopover.showingFirst", {
            shown: summary.count,
            total: changedFilesTotal,
          })}
        </p>
      ) : null}
      {renderGroup(t("thread.publishPopover.pagesGroup"), summary.pages)}
      {renderGroup(t("thread.publishPopover.blocksGroup"), summary.blocks)}
      {renderGroup(t("thread.publishPopover.otherGroup"), summary.other)}
      {bodiesFailed ? (
        <p className="text-[11px] text-muted-foreground">
          {t("thread.publishPopover.detailsUnavailable")}
        </p>
      ) : null}
    </PublishListRegion>
  );

  const reviewPane = cardsPending ? (
    <ReviewPaneGhost />
  ) : selected ? (
    <div className={cn(REVIEW_PANE, "relative")}>
      {changes
        .filter((change) => liveIds.includes(changeId(change)))
        .map((change) => (
          <div
            key={changeId(change)}
            className={cn(
              "absolute inset-0 flex",
              changeId(change) !== selectedId && "hidden",
            )}
          >
            <PublishCompare
              change={change}
              diff={gitDiff}
              bodyPending={bodiesPending}
              previewServerUrl={previewServerUrl}
              draft={compareDraft}
              lastPage={lastPreviewPage}
            />
          </div>
        ))}
    </div>
  ) : (
    <div className={cn(REVIEW_PANE, "bg-muted/40")} />
  );

  return (
    <ReviewLayout
      pane={reviewPane}
      list={
        <PublishFrame
          state={surfaceState}
          header={
            <HeaderLine
              mode={mode}
              title={<span className="truncate">{headerTitle}</span>}
              subLine={subLine}
              trailing={discardAllControl}
            />
          }
          body={body}
          note={
            summary.count === 0 ? null : (
              <>
                <span className="text-[13px] font-medium">
                  {isReview
                    ? t("thread.publishPopover.reviewNote")
                    : t("thread.publishPopover.versionNote")}
                </span>
                <Textarea
                  value={note}
                  onChange={(e) => setEditedNote(e.target.value)}
                  placeholder={
                    isReview
                      ? t("thread.publishPopover.reviewNotePlaceholder")
                      : t("thread.publishPopover.versionNotePlaceholder")
                  }
                  rows={2}
                  className="resize-none text-[13px]"
                  disabled={isPublishing}
                />
              </>
            )
          }
          gate={gateRow}
          footer={
            <>
              <div className="flex gap-2">
                <PreviewButton draftPreviewUrl={draftPreviewUrl} t={t} />
                {!isReview &&
                !hosted &&
                summary.count > 0 &&
                !gate.allowed &&
                !gate.pending ? (
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={onRequestApproval}
                    disabled={isPublishing}
                  >
                    {t("thread.publishPopover.requestApproval")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant={isReview ? "default" : "brand"}
                    className="flex-1"
                    onClick={() => void submit()}
                    disabled={!canSubmit}
                  >
                    {isPublishing ? (
                      <Spinner className="size-4 motion-reduce:animate-none" />
                    ) : null}
                    {isPublishing
                      ? isReview
                        ? t("thread.publishPopover.submitting")
                        : t("thread.publishPopover.publishing")
                      : primaryLabel}
                  </Button>
                )}
              </div>
              {publishError ? (
                <p className="text-xs text-destructive">{publishError}</p>
              ) : null}
            </>
          }
        />
      }
    />
  );
}
