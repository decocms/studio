/**
 * Fast Preview's content-first publish surface — presentation only: reads come
 * from {@link useCmsPublishState}, writes from {@link useCmsPublishActions}.
 * Loads in two beats — see {@link useCmsPublishState} for what each decides.
 * With `visualReview` it is a fullscreen dialog with a before/after pane.
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
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@decocms/ui/components/popover.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  AlertTriangle,
  CheckCircle,
  Eye,
  GitPullRequest,
  Globe01,
  RefreshCw01,
} from "@untitledui/icons";
import {
  Suspense,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import type { LastPreviewPage } from "@/components/sandbox/preview/last-preview-page.ts";
import { changeId, PublishChangeCard } from "./cms-publish-change-card.tsx";
import { PublishCompare } from "./cms-publish-compare.tsx";
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
import { readGitHeadBranch, type PublishPolicy } from "./sandbox-git-api.ts";
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

const NARROW_VIEWPORT_QUERY = "(max-width: 479px)";

function subscribeNarrowViewport(onChange: () => void) {
  const mql = globalThis.matchMedia(NARROW_VIEWPORT_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Below 480px the popover has no room — the same content mounts in a modal. */
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeNarrowViewport,
    () => globalThis.matchMedia(NARROW_VIEWPORT_QUERY).matches,
    () => false,
  );
}

export interface CmsPublishPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Defaults to `publish`; see the module doc for what each mode runs. */
  mode?: CmsPublishMode;
  orgSlug: string;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  baseBranch: string;
  /** Which repository this publishes to, and which credential writes it. */
  repoTarget: RepoToolTarget;
  owner: string;
  repo: string;
  publishPolicy: PublishPolicy;
  /** Draft URL + destination host from useFastPreviewDraftUrl. */
  draftPreviewUrl: string | null;
  destinationHost: string | null;
  /** Live site origin the review pane renders each changed page against. */
  previewServerUrl: string | null;
  /** This session's `?__draft=` pointer (useDraftPointer). */
  draftPointer: string | null;
  /** Fills a dynamic page's `:param`s when it is the page last previewed. */
  lastPreviewPage: LastPreviewPage | null;
  /** `metadata.publishVisualReview`: fullscreen before/after review instead of the popover. */
  visualReview: boolean;
  /** The last publish, warmed by the header — never blocks this surface. */
  lastPublishedPr?: PrSummary | null;
  /** Blocked gate: hand this surface over to review mode. */
  onRequestApproval: () => void;
  /** When set, publish updates this open PR instead of opening a new one. */
  openPullRequest?: PrSummary | null;
  onPullRequestChanged?: () => void | Promise<void>;
  onPublished?: () => void | Promise<void>;
  /** The trigger the popover anchors to (the header's Publish split button). */
  children: ReactNode;
}

export function CmsPublishPopover(props: CmsPublishPopoverProps) {
  const narrow = useNarrowViewport();
  /** Set by the body while the publish flow runs — an outside click or Escape
   *  must not dismiss the only surface showing that progress. */
  const publishLockRef = useRef(false);
  const t = useT();

  const handleOpenChange = (next: boolean) => {
    if (!next && publishLockRef.current) return;
    props.onOpenChange(next);
  };

  if (props.visualReview) {
    return (
      <>
        {props.children}
        <Dialog open={props.open} onOpenChange={handleOpenChange}>
          <DialogContent
            aria-describedby={undefined}
            className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-row md:h-[calc(100dvh-6rem)] md:w-[calc(100vw-6rem)] gap-0 overflow-hidden p-0 sm:max-w-none"
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
      </>
    );
  }

  if (narrow) {
    return (
      <>
        {props.children}
        <Dialog open={props.open} onOpenChange={handleOpenChange}>
          <DialogContent className="flex max-h-[85vh] w-[92vw] max-w-[420px] flex-col gap-0 overflow-hidden p-0">
            {props.open ? (
              <CmsPublishBody {...props} publishLockRef={publishLockRef} />
            ) : null}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Popover open={props.open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{props.children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        // The menu that opened this returns focus to its trigger as it closes.
        onFocusOutside={(event) => event.preventDefault()}
        className="flex max-h-[min(720px,85vh)] w-[420px] flex-col gap-0 overflow-hidden p-0"
      >
        <CmsPublishBody {...props} publishLockRef={publishLockRef} />
      </PopoverContent>
    </Popover>
  );
}

/** Visual review: the review pane beside the list column, whose header clears the close button. */
function ReviewLayout({
  visualReview,
  list,
  pane,
}: {
  visualReview: boolean;
  list: ReactNode;
  pane: ReactNode;
}) {
  if (!visualReview) return list;
  return (
    <>
      {pane}
      <div className="flex min-h-0 w-full flex-col max-md:pt-8 md:w-[380px] md:shrink-0 md:border-l md:[&>[data-publish-state]>:first-child]:pr-12">
        {list}
      </div>
    </>
  );
}

function ReviewPaneGhost() {
  return (
    <div className="hidden min-w-0 flex-1 bg-muted/40 p-3 md:flex">
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
  visualReview,
}: {
  mode: CmsPublishMode;
  draftPreviewUrl: string | null;
  visualReview: boolean;
}) {
  const t = useT();
  return (
    <ReviewLayout
      visualReview={visualReview}
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
  visualReview,
}: {
  mode: CmsPublishMode;
  draftPreviewUrl: string | null;
  message: string;
  onRetry: () => void;
  visualReview: boolean;
}) {
  const t = useT();
  return (
    <ReviewLayout
      visualReview={visualReview}
      pane={<div className="hidden min-w-0 flex-1 bg-muted/40 md:flex" />}
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
  props: CmsPublishPopoverProps & {
    publishLockRef: React.MutableRefObject<boolean>;
  },
) {
  const mode = props.mode ?? "publish";
  return (
    <ErrorBoundary
      fallback={({ error, resetError }) => (
        <CmsPublishLoadError
          mode={mode}
          draftPreviewUrl={props.draftPreviewUrl}
          message={error?.message ?? ""}
          onRetry={resetError}
          visualReview={props.visualReview}
        />
      )}
    >
      <Suspense
        fallback={
          <CmsPublishSkeleton
            mode={mode}
            draftPreviewUrl={props.draftPreviewUrl}
            visualReview={props.visualReview}
          />
        }
      >
        <CmsPublishContent {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

function CmsPublishContent({
  publishLockRef,
  onOpenChange,
  mode = "publish",
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
  draftPointer,
  lastPreviewPage,
  visualReview,
  lastPublishedPr = null,
  onRequestApproval,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
}: CmsPublishPopoverProps & {
  publishLockRef: React.MutableRefObject<boolean>;
}) {
  const t = useT();
  /** The session publishing — the git routes resolve their runtime from it. */
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const { data: session } = authClient.useSession();

  const {
    status: gitStatus,
    summary,
    allPaths,
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
  });

  /** The author's text once they type — until then the note is derived, so a
   *  change list that lands after mount still describes itself. */
  const [editedNote, setEditedNote] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  /** The selected card (visual review) or the expanded one (popover). */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Only one card may arm its discard at a time — it is a one-click destroy. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const note = resolveVersionNote(editedNote, buildAutoNote(summary));
  const changes = [...summary.pages, ...summary.blocks, ...summary.other];
  /** Falls back to the first change, so a discard never leaves the pane blank. */
  const selected =
    changes.find((change) => changeId(change) === activeId) ??
    changes[0] ??
    null;
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
    fastPreview: true,
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
    fastPreview: true,
    baseBranch,
    target: repoTarget,
    owner,
    repo,
    headBranch: readGitHeadBranch(gitStatus) ?? branch,
    coAuthor: coAuthorFromSessionUser(session?.user),
    expectedHeadSha: headSha ?? undefined,
  };

  const {
    isPublishing,
    isDiscarding,
    publishError,
    submit,
    discardChange,
    discardAll,
    hostedPending,
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
              mode={
                visualReview
                  ? {
                      kind: "select",
                      selected: selected !== null && changeId(selected) === id,
                      onSelect: () => setActiveId(id),
                    }
                  : {
                      kind: "expand",
                      expanded: activeId === id,
                      onToggleExpanded: () =>
                        setActiveId(activeId === id ? null : id),
                      diff: gitDiff,
                    }
              }
              confirming={confirmingId === id}
              onConfirmingChange={(confirming) =>
                setConfirmingId(confirming ? id : null)
              }
              onDiscard={() => void discardChange(change)}
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
    summary.count <= 1 || changedFilesTruncated ? null : (
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
    <div className="hidden min-w-0 flex-1 md:flex">
      <PublishCompare
        key={changeId(selected)}
        change={selected}
        diff={gitDiff}
        bodyPending={bodiesPending}
        previewServerUrl={previewServerUrl}
        draftPointer={draftPointer}
        lastPage={lastPreviewPage}
      />
    </div>
  ) : (
    <div className="hidden min-w-0 flex-1 bg-muted/40 md:flex" />
  );

  return (
    <ReviewLayout
      visualReview={visualReview}
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
              {hostedPending ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void hostedPending.resync()}
                  disabled={hostedPending.isResyncing}
                >
                  {hostedPending.isResyncing ? (
                    <Spinner className="size-4 motion-reduce:animate-none" />
                  ) : null}
                  {hostedPending.needsConfirm
                    ? t("thread.publishPopover.resyncAnyway")
                    : t("thread.publishPopover.resync")}
                </Button>
              ) : null}
            </>
          }
        />
      }
    />
  );
}
