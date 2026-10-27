/**
 * The shared content-first publish surface — presentation only: reads come
 * from {@link useCmsPublishState} on a v7 site (git) and from
 * {@link useContentPublishState} on a v8 one (the content protocol's
 * changes), writes from {@link useCmsPublishActions}. Loads in two beats: the
 * list, then what changed inside each card.
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
import { Button, buttonVariants } from "@decocms/ui/components/button.tsx";
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
import { QueryErrorResetBoundary, useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { readHostedPublishReview } from "./hosted-publish-api";
import { publishBodyShown, usePublishHold } from "./publish-hold";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { formatRelativeTime } from "@/lib/format-time.ts";
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
  blockKeyFromDiffPath,
  buildAutoNote,
  resolveVersionNote,
  type PublishChange,
  type PublishChangeSummary,
} from "./publish-change-summary.ts";
import { MAX_TITLE_LENGTH, type PublishTarget } from "./publish-flow.ts";
import {
  type GitDiffResult,
  isGeneratedArtifactPath,
  type PublishGate,
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
import {
  type ContentPublishState,
  useContentPublishState,
} from "./use-content-publish-state.ts";
import { useResolvedPublishGate } from "@/components/sandbox/hooks/use-publish-gate.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useContentBackend } from "@/components/sections-editor/use-content-backend.ts";
import { useDecofileCacheKey } from "@/components/sections-editor/use-decofile.ts";
import type { ProtocolBackend } from "@/components/sections-editor/content-backend.ts";
import { useContentSyncState } from "@/components/sections-editor/content-sync.ts";
import { ErrorDetails } from "@/components/sections-editor/site-editor-toast.tsx";
import { publishTitle } from "./publish-title.ts";
import { REVIEW_PANE_READY_MS, shownReviewPane } from "./review-pane-swap.ts";

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
  /**
   * A hosted v8 site whose visitors see an older release than main's (a
   * Publish whose release failed): with nothing listed, Publish still makes
   * the saved changes live.
   */
  notLive?: boolean;
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
        <PublishDialogBody {...props} publishLockRef={publishLockRef} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's body, mounted only with its content (open, or fading out once
 * closed), so a closed dialog asks nothing about the site's content: the
 * backend is read here, never by the header that renders the dialog.
 */
function PublishDialogBody(
  props: PublishDialogProps & {
    publishLockRef: React.MutableRefObject<boolean>;
  },
) {
  const backend = useContentBackend(props.virtualMcpId, props.branch);
  const hosted = backend.kind === "protocol" && backend.source === "github";
  return publishBodyShown({ open: props.open, hosted }) ? (
    <CmsPublishBody {...props} />
  ) : null;
}

/** Review panes kept alive at once — each holds up to two full-page frames. */
const MAX_LIVE_PANES = 4;

/** Above the list on narrow screens, beside it from `md` up. */
export const REVIEW_PANE =
  "flex h-[45%] min-h-0 min-w-0 shrink-0 md:h-auto md:flex-1";

/** The review pane beside the list column, whose header clears the close button. */
export function ReviewLayout({
  list,
  pane,
}: {
  list: ReactNode;
  pane: ReactNode;
}) {
  return (
    <>
      {pane}
      <div className="flex min-h-0 w-full flex-1 flex-col max-md:border-t md:w-[380px] md:flex-none md:shrink-0 md:border-l md:[&>[data-publish-state]>:first-child]:pr-12">
        {list}
      </div>
    </>
  );
}

export function ReviewPaneGhost() {
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

/** What the dialog lists and acts on: git (v7) or the content protocol (v8). */
interface PublishSource {
  summary: PublishChangeSummary;
  /** v7: every changed path, what "discard all" reverts. */
  allPaths: string[];
  canDiscard: (change: PublishChange) => boolean;
  canDiscardAll: boolean;
  changedFilesTotal: number;
  changedFilesTruncated: boolean;
  /** v7: the file bodies the Code tab slices. v8 cards carry their sides. */
  diff: GitDiffResult | null;
  bodiesPending: boolean;
  bodiesFailed: boolean;
  cardsPending: boolean;
  refresh: () => Promise<unknown>;
  gate: PublishGate;
  headBranch: string;
  expectedHeadSha?: string;
  expectedDiffSignature?: string;
  /** A hosted v8 draft: no pull request, Publish goes through the CDN draft. */
  hosted: boolean;
  /**
   * Hosted v8: the draft's blocks a developer also changed on main since the
   * live release. Publish keeps the draft's version; the cards say so.
   */
  alsoChanged?: ReadonlySet<string>;
  /** v8: discards go through `changes.discard` on this backend. */
  protocol?: {
    backend: ProtocolBackend;
    entries: Array<{ name: string; version: string | null }>;
  };
  /** A v8 sandbox's Publish also carries work these changes don't list. */
  otherWork: boolean;
  /** A Blocks v8 site, with its current blocks: the compare never uses v7's
   *  isolated-section route there. Absent on v7. */
  v8?: { blocks: Record<string, unknown> | null };
}

type CmsPublishContentProps = PublishDialogProps & {
  publishLockRef: React.MutableRefObject<boolean>;
};

/** Picks the source: the content protocol on a v8 site, git otherwise. */
function CmsPublishContent(props: CmsPublishContentProps) {
  const backend = useContentBackend(props.virtualMcpId, props.branch);
  const cacheKey = useDecofileCacheKey({
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId,
    branch: props.branch,
  });
  if (backend.kind === "protocol" && cacheKey) {
    return backend.source === "sandbox" ? (
      <SandboxContentPublish {...props} backend={backend} cacheKey={cacheKey} />
    ) : (
      <ContentPublish {...props} backend={backend} cacheKey={cacheKey} />
    );
  }
  // Until the backend is known, the dialog would read (and publish) the
  // wrong way on a v8 site: it waits.
  if (backend.kind !== "legacy") {
    return (
      <CmsPublishSkeleton
        mode={props.mode ?? "publish"}
        draftPreviewUrl={props.draftPreviewUrl}
      />
    );
  }
  return <GitPublish {...props} />;
}

/** A v7 site: the changes, the gate and the discards are git's. */
function GitPublish(props: CmsPublishContentProps) {
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const state = useCmsPublishState({
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId,
    branch: props.branch,
    threadId,
    baseBranch: props.baseBranch,
    fastPreview: props.fastPreview,
    recoverSandbox: props.recoverSandbox,
  });
  // Submitting for review IS the escalation the gate asks for — never judge it.
  const { gate } = useResolvedPublishGate({
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId,
    branch: props.branch,
    threadId,
    fastPreview: props.fastPreview,
    status: state.status,
    diff: state.diff,
    paths: state.allPaths,
    policy: props.publishPolicy,
    judgeEnabled: props.mode !== "review",
  });
  const discardable = state.discardablePaths;
  const canDiscardPaths = (paths: readonly string[]) =>
    discardable === null || paths.every((p) => discardable.has(p));
  return (
    <CmsPublishView
      {...props}
      source={{
        summary: state.summary,
        allPaths: state.allPaths,
        canDiscard: (change) => canDiscardPaths(change.filepaths),
        // Never offer an all-files action over a set the server truncated.
        canDiscardAll:
          !state.changedFilesTruncated && canDiscardPaths(state.allPaths),
        changedFilesTotal: state.changedFilesTotal,
        changedFilesTruncated: state.changedFilesTruncated,
        diff: state.diff,
        bodiesPending: state.bodiesPending,
        bodiesFailed: state.bodiesFailed,
        cardsPending: state.cardsPending,
        refresh: state.refresh,
        gate,
        headBranch: readGitHeadBranch(state.status) ?? props.branch,
        expectedHeadSha: state.headSha ?? undefined,
        ...(!props.fastPreview && state.diff
          ? { expectedDiffSignature: reviewDiffSignature(state.diff) }
          : {}),
        hosted: false,
        otherWork: false,
      }}
    />
  );
}

/** The v8 list's part of a source (content-changes.ts): every entry discardable. */
function contentListSource(
  state: ContentPublishState,
  backend: ProtocolBackend,
) {
  return {
    summary: state.summary,
    allPaths: [],
    canDiscard: () => true,
    canDiscardAll: true,
    changedFilesTotal: state.summary.count,
    changedFilesTruncated: false,
    diff: null,
    bodiesPending: state.sidesPending,
    bodiesFailed: state.sidesFailed,
    cardsPending: false,
    refresh: state.refresh,
    protocol: { backend, entries: state.entries },
    v8: { blocks: state.blocks },
  };
}

/**
 * A hosted v8 site (the draft against main): no pull request and no review
 * path, so nothing gates its Publish.
 */
function ContentPublish({
  backend,
  cacheKey,
  ...props
}: CmsPublishContentProps & { backend: ProtocolBackend; cacheKey: string }) {
  const state = useContentPublishState({
    backend,
    cacheKey,
    scope: {
      orgSlug: props.orgSlug,
      virtualMcpId: props.virtualMcpId,
      branch: props.branch,
    },
  });
  const hosted = backend.source === "github";
  const review = useQuery({
    queryKey: KEYS.hostedPublishReview(
      props.orgSlug,
      props.virtualMcpId,
      props.branch,
    ),
    queryFn: () =>
      readHostedPublishReview({
        orgSlug: props.orgSlug,
        virtualMcpId: props.virtualMcpId,
        branch: props.branch,
      }),
    enabled: hosted,
    staleTime: 0,
  });
  return (
    <CmsPublishView
      {...props}
      source={{
        ...contentListSource(state, backend),
        gate: { allowed: true, reason: null },
        headBranch: props.branch,
        hosted,
        alsoChanged: new Set(review.data?.alsoChanged ?? []),
        otherWork: false,
      }}
    />
  );
}

/**
 * A v8 sandbox: the list, the Code tab and the discards come from the
 * content protocol (its working tree against its last commit). Its Publish
 * is git's (it pushes the session's work and merges it), so the Publish step
 * and its review gate still read the branch's git status and diff, and the
 * dialog says when that carries more than the listed changes (code, or
 * changes already committed in the session).
 */
function SandboxContentPublish({
  backend,
  cacheKey,
  ...props
}: CmsPublishContentProps & { backend: ProtocolBackend; cacheKey: string }) {
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const state = useContentPublishState({
    backend,
    cacheKey,
    scope: {
      orgSlug: props.orgSlug,
      virtualMcpId: props.virtualMcpId,
      branch: props.branch,
    },
  });
  const git = useCmsPublishState({
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId,
    branch: props.branch,
    threadId,
    baseBranch: props.baseBranch,
    fastPreview: props.fastPreview,
    recoverSandbox: props.recoverSandbox,
  });
  const { gate } = useResolvedPublishGate({
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId,
    branch: props.branch,
    threadId,
    fastPreview: props.fastPreview,
    status: git.status,
    diff: git.diff,
    paths: git.allPaths,
    policy: props.publishPolicy,
    judgeEnabled: props.mode !== "review",
  });
  const otherWork = git.allPaths.some((path) => {
    const name = blockKeyFromDiffPath(path);
    return name === null
      ? !isGeneratedArtifactPath(path)
      : !Object.hasOwn(state.changes.changes, name);
  });
  return (
    <CmsPublishView
      {...props}
      source={{
        ...contentListSource(state, backend),
        // The git refresh too: a discard can leave the branch's diff moved.
        refresh: () => Promise.all([state.refresh(), git.refresh()]),
        gate,
        headBranch: readGitHeadBranch(git.status) ?? props.branch,
        expectedHeadSha: git.headSha ?? undefined,
        ...(git.diff
          ? { expectedDiffSignature: reviewDiffSignature(git.diff) }
          : {}),
        hosted: false,
        otherWork,
      }}
    />
  );
}

function CmsPublishView({
  source,
  publishLockRef,
  onOpenChange,
  mode = "publish",
  fastPreview,
  orgSlug,
  virtualMcpId,
  branch,
  baseBranch,
  repoTarget,
  owner,
  repo,
  draftPreviewUrl,
  destinationHost,
  previewServerUrl,
  compareDraft: liveCompareDraft,
  lastPublishedPr = null,
  onRequestApproval,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
  notLive: releaseBehind = false,
}: CmsPublishContentProps & { source: PublishSource }) {
  const t = useT();
  const [{ language }] = usePreferences();
  /** The session publishing — the git routes resolve their runtime from it. */
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const { data: session } = authClient.useSession();

  /** Fills a dynamic page's `:param`s when it is the page last previewed. */
  const lastPreviewPage = readLastPreviewPage(
    lastPreviewPageKey(orgSlug, virtualMcpId, branch),
  );

  const {
    allPaths,
    changedFilesTotal,
    changedFilesTruncated,
    diff: gitDiff,
    bodiesFailed,
    refresh,
    gate,
    hosted,
    otherWork,
  } = source;
  /**
   * A hosted Publish keeps showing the list it publishes until the dialog
   * closes on the published state; its end re-reads the emptied draft
   * (publish-hold.ts). Taken when Publish is clicked, kept through the
   * dialog's fade, released only when the Publish failed.
   */
  type ShownList = Pick<
    PublishSource,
    "summary" | "cardsPending" | "bodiesPending"
  > & { compareDraft: CompareDraft | null };
  const liveList: ShownList = {
    summary: source.summary,
    cardsPending: source.cardsPending,
    bodiesPending: source.bodiesPending,
    compareDraft: liveCompareDraft,
  };
  const publishHold = usePublishHold(liveList, { hosted });
  // The review panes keep the draft they showed too: the emptied draft's
  // new pointer would reload every pane while the dialog closes.
  const { summary, cardsPending, bodiesPending, compareDraft } =
    publishHold.shown;

  /** The author's text once they type — until then the note is derived, so a
   *  change list that lands after mount still describes itself. */
  const [editedNote, setEditedNote] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  /** v8: review panes whose pages have loaded (review-pane-swap.ts). */
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markReady = (id: string) =>
    setReadyIds((current) =>
      current.has(id) ? current : new Set(current).add(id),
    );
  /** The card shown in the review pane. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Cards visited, most recent first — their panes stay mounted. */
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  const select = (id: string) => {
    setActiveId(id);
    setVisitedIds((current) => [id, ...current.filter((v) => v !== id)]);
    // v8: a pane whose pages never say they loaded shows anyway.
    if (source.v8) setTimeout(() => markReady(id), REVIEW_PANE_READY_MS);
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
  // A Blocks (v8) site: the panes stay laid out (invisible, not `hidden`), so
  // a picked pane is already sized and painted, and the one on screen stays
  // until the picked one's pages load (review-pane-swap.ts). v7 as before.
  const smoothPanes = !!source.v8;
  const [lastShownId, setLastShownId] = useState<string | null>(null);
  const shownId = smoothPanes
    ? shownReviewPane({ selectedId, readyIds, lastShownId, liveIds })
    : selectedId;
  if (smoothPanes && shownId === selectedId && shownId !== lastShownId) {
    setLastShownId(shownId);
  }
  // A hosted v8 draft has no pull request: review mode doesn't apply to it.
  const isReview = mode === "review" && !hosted;
  const surfaceState: PublishSurfaceState = cardsPending
    ? "loading"
    : bodiesPending
      ? "manifest"
      : "ready";

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
    headBranch: source.headBranch,
    coAuthor: coAuthorFromSessionUser(session?.user),
    expectedHeadSha: source.expectedHeadSha,
    ...(source.expectedDiffSignature
      ? { expectedDiffSignature: source.expectedDiffSignature }
      : {}),
  };

  const {
    isPublishing,
    publishError,
    publishErrorDetail,
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
    authorName: session?.user?.name,
    protocol: source.protocol,
  });

  // A content change is being written (a discard, or an edit still saving).
  const isDiscarding =
    useContentSyncState(orgSlug, virtualMcpId).phase === "saving";

  /** Saved, nothing listed, but not live yet: Publish makes main live. */
  const notLive = hosted && releaseBehind && summary.count === 0;
  /** Changes to publish: the listed ones, a v8 sandbox's other work, or a
   *  hosted site's saved changes that aren't live yet. */
  const hasWork = summary.count > 0 || otherWork || notLive;
  const canSubmit = !isPublishing && hasWork && (isReview || gate.allowed);

  const headerTitle = isReview
    ? summary.count === 0
      ? t("thread.publishPopover.submitForReview")
      : summary.count === 1
        ? t("thread.publishPopover.submitOneForReview")
        : t("thread.publishPopover.submitCountForReview", {
            count: summary.count,
          })
    : notLive
      ? t("thread.publishPopover.notLive")
      : publishTitle(summary.count, baseBranch, !!source.v8, t);

  /** Review mode names the PR it will update; publish mode, the last release. */
  const subLine = (() => {
    if (isReview && commitToOpenPr) {
      return t("thread.publishPopover.updatesPullRequest", {
        number: openPullRequest.number,
      });
    }
    const pr = lastPublishedPr;
    if (!pr?.mergedAt) return null;
    const when = formatRelativeTime(new Date(pr.mergedAt), language);
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
        <div className="px-0.5 text-2xs font-medium text-muted-foreground">
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
                source.canDiscard(change)
                  ? () => void discardChange(change)
                  : undefined
              }
              isPublishing={isPublishing}
              isDiscarding={isDiscarding}
              v8={!!source.v8}
              alsoChangedOnMain={
                !!source.alsoChanged &&
                source.alsoChanged.has(
                  change.entry?.name ?? change.blockKey ?? "",
                )
              }
            />
          );
        })}
      </div>
    );
  };

  const gateRow = (() => {
    if (isReview || !hasWork) return null;
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

  const discardAllControl =
    summary.count <= 1 || !source.canDiscardAll ? null : (
      <>
        <button
          type="button"
          className="ml-auto shrink-0 text-2xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
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
                className={cn(buttonVariants({ variant: "destructive" }))}
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
  ) : summary.count === 0 && otherWork ? (
    <p className="px-4 py-6 text-xs text-muted-foreground">
      {t("thread.publishPopover.onlyOtherWork")}
    </p>
  ) : notLive ? (
    <div className="flex flex-col items-center gap-1 py-10 text-center">
      <Globe01 className="mb-1 size-5 text-muted-foreground" />
      <p className="text-sm font-medium">
        {t("thread.publishPopover.notLiveBody")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("thread.publishPopover.notLiveHint")}
      </p>
    </div>
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
        <p className="text-2xs text-muted-foreground">
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
        <p className="text-2xs text-muted-foreground">
          {t("thread.publishPopover.detailsUnavailable")}
        </p>
      ) : null}
      {otherWork ? (
        <p className="text-2xs text-muted-foreground">
          {t("thread.publishPopover.alsoOtherWork")}
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
              smoothPanes
                ? changeId(change) === shownId
                  ? "z-10"
                  : "pointer-events-none opacity-0"
                : changeId(change) !== selectedId && "hidden",
            )}
            inert={smoothPanes && changeId(change) !== shownId}
            aria-hidden={
              smoothPanes && changeId(change) !== shownId ? true : undefined
            }
          >
            <PublishCompare
              change={change}
              diff={gitDiff}
              bodyPending={bodiesPending}
              previewServerUrl={previewServerUrl}
              draft={compareDraft}
              lastPage={lastPreviewPage}
              v8={source.v8}
              onReady={
                smoothPanes ? () => markReady(changeId(change)) : undefined
              }
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
                <span className="text-sm font-medium">
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
                  maxLength={MAX_TITLE_LENGTH}
                  className="resize-none text-sm"
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
                hasWork &&
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
                    onClick={() => {
                      publishHold.hold();
                      // Kept through the close: released only when the
                      // Publish failed and the dialog stays.
                      void submit().then((published) => {
                        if (published === false) publishHold.release();
                      });
                    }}
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
                <div>
                  <p className="text-xs text-destructive">{publishError}</p>
                  {publishErrorDetail ? (
                    <ErrorDetails
                      label={t("siteEditor.details")}
                      detail={publishErrorDetail}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          }
        />
      }
    />
  );
}
