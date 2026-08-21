/**
 * Fast Preview's content-first publish surface — presentation only: reads come
 * from {@link useCmsPublishState}, writes from {@link useCmsPublishActions}.
 * Loads in two beats — see {@link useCmsPublishState} for what each decides.
 */

import { useMCPClient } from "@/sdk";
import { Button } from "@decocms/ui/components/button.tsx";
import { Dialog, DialogContent } from "@decocms/ui/components/dialog.tsx";
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
  Loading01,
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
import { changeId, PublishChangeCard } from "./cms-publish-change-card.tsx";
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
  githubConnectionId: string;
  owner: string;
  repo: string;
  publishPolicy: PublishPolicy;
  /** Draft URL + destination host from useFastPreviewDraftUrl. */
  draftPreviewUrl: string | null;
  destinationHost: string | null;
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

  const handleOpenChange = (next: boolean) => {
    if (!next && publishLockRef.current) return;
    props.onOpenChange(next);
  };

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
  );
}

function CmsPublishContent({
  publishLockRef,
  onOpenChange,
  mode = "publish",
  orgSlug,
  orgId,
  virtualMcpId,
  branch,
  baseBranch,
  githubConnectionId,
  owner,
  repo,
  publishPolicy,
  draftPreviewUrl,
  destinationHost,
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
  const githubClient = useMCPClient({
    connectionId: githubConnectionId,
    orgId,
    orgSlug,
  });
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Only one card may arm its discard at a time — it is a one-click destroy. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const note = resolveVersionNote(editedNote, buildAutoNote(summary));
  const isReview = mode === "review";
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
    baseBranch,
    githubClient,
    owner,
    repo,
    headBranch: readGitHeadBranch(gitStatus) ?? branch,
    coAuthor: coAuthorFromSessionUser(session?.user),
    expectedHeadSha: headSha ?? undefined,
    existingOpenPr: commitToOpenPr
      ? { number: openPullRequest.number, htmlUrl: openPullRequest.htmlUrl }
      : undefined,
  };

  const {
    isPublishing,
    isDiscarding,
    publishError,
    submit,
    discardChange,
    discardAll,
  } = useCmsPublishActions({
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
              diff={gitDiff}
              bodyPending={bodiesPending}
              expanded={expandedId === id}
              onToggleExpanded={() =>
                setExpandedId(expandedId === id ? null : id)
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
          <Loading01 className="size-3.5 animate-spin motion-reduce:animate-none" />
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

  const discardAllControl = (() => {
    // Never offer an all-files action over a set the server truncated.
    if (summary.count <= 1 || changedFilesTruncated) return null;
    if (discardAllConfirm) {
      return (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
          <span className="text-destructive">
            {t("thread.publishPopover.discardAllConfirm")}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setDiscardAllConfirm(false)}
          >
            {t("thread.publishDialog.cancel")}
          </button>
          <button
            type="button"
            className="font-medium text-destructive disabled:opacity-50"
            onClick={() => {
              setDiscardAllConfirm(false);
              void discardAll();
            }}
            disabled={isDiscarding}
          >
            {t("thread.publishPopover.discard")}
          </button>
        </span>
      );
    }
    return (
      <button
        type="button"
        className="ml-auto shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
        onClick={() => setDiscardAllConfirm(true)}
        disabled={isPublishing || isDiscarding}
      >
        {t("thread.publishPopover.discardAll")}
      </button>
    );
  })();

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

  return (
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
                  <Loading01 className="size-4 animate-spin motion-reduce:animate-none" />
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
  );
}
