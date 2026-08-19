/**
 * Fast Preview's content-first publish surface — presentation only: reads come
 * from {@link useCmsPublishState}, writes from {@link useCmsPublishActions}.
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
} from "@untitledui/icons";
import {
  Suspense,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { changeId, PublishChangeCard } from "./cms-publish-change-card.tsx";
import { lastPublishAttribution } from "./pr-attribution.ts";
import {
  buildAutoNote,
  summarizePublishChanges,
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
        // The menu that opened this returns focus to its trigger as it closes.
        onFocusOutside={(event) => event.preventDefault()}
        className="flex max-h-[min(720px,85vh)] w-[420px] flex-col gap-0 overflow-hidden p-0"
      >
        <CmsPublishBody {...props} publishLockRef={publishLockRef} />
      </PopoverContent>
    </Popover>
  );
}

function Ghost({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

/** Ghost card matching the change-card anatomy, so loaded content lands in
 *  shapes that were already on screen instead of after a layout jump. */
function GhostCard({ subline }: { subline?: boolean }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Ghost className="size-4 rounded-md" />
        <Ghost className="h-3 w-24" />
        <Ghost className="h-2.5 w-16" />
        <Ghost className="ml-auto size-5 rounded-md" />
      </div>
      {subline ? <Ghost className="mt-1.5 ml-[26px] h-2.5 w-56" /> : null}
    </div>
  );
}

function CmsPublishSkeleton({ mode }: { mode: CmsPublishMode }) {
  const t = useT();
  const HeaderIcon = mode === "review" ? GitPullRequest : Globe01;
  return (
    <>
      <div className="space-y-1.5 px-4 py-3">
        <div className="flex items-center gap-2">
          <HeaderIcon className="size-4 shrink-0 text-muted-foreground" />
          <Ghost className="h-3.5 w-48" />
        </div>
        <Ghost className="ml-6 h-2.5 w-36" />
      </div>
      <div className="border-t" />
      <div className="space-y-1.5 px-4 pt-3 pb-2">
        <Ghost className="h-2 w-12" />
        <GhostCard subline />
        <GhostCard />
        <Ghost className="mt-2 h-2 w-14" />
        <GhostCard />
      </div>
      <div className="space-y-1.5 border-t px-4 py-3">
        <Ghost className="h-2.5 w-20" />
        <Ghost className="h-14 w-full rounded-lg" />
      </div>
      <div className="border-t" />
      <div className="flex gap-2 px-4 py-3 opacity-50">
        <Button type="button" variant="outline" disabled>
          <Eye className="size-4" />
          {t("thread.publishPopover.preview")}
        </Button>
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
    </>
  );
}

function CmsPublishBody(
  props: CmsPublishPopoverProps & {
    publishLockRef: React.MutableRefObject<boolean>;
  },
) {
  return (
    <Suspense fallback={<CmsPublishSkeleton mode={props.mode ?? "publish"} />}>
      <CmsPublishContent {...props} />
    </Suspense>
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
  onRequestApproval,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
}: CmsPublishPopoverProps & {
  publishLockRef: React.MutableRefObject<boolean>;
}) {
  const t = useT();
  const githubClient = useMCPClient({
    connectionId: githubConnectionId,
    orgId,
    orgSlug,
  });
  const { data: session } = authClient.useSession();

  const {
    status: gitStatus,
    diff: gitDiff,
    lastPublishedPr,
    loadError,
    refresh,
  } = useCmsPublishState({
    githubClient,
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
    owner,
    repo,
  });

  const [note, setNote] = useState(() =>
    gitDiff ? buildAutoNote(summarizePublishChanges(gitDiff)) : "",
  );
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Only one card may arm its discard at a time — it is a one-click destroy. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const summary = summarizePublishChanges(gitDiff);
  const isReview = mode === "review";
  const HeaderIcon = isReview ? GitPullRequest : Globe01;

  // Submitting for review IS the escalation the gate asks for — never judge it.
  const { gate } = useResolvedPublishGate({
    orgSlug,
    virtualMcpId,
    branch,
    status: gitStatus,
    diff: gitDiff,
    policy: publishPolicy,
    judgeEnabled: !isReview,
  });

  const commitToOpenPr = openPullRequest?.state === "open";
  const target: PublishTarget = {
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
    githubClient,
    owner,
    repo,
    headBranch: readGitHeadBranch(gitStatus) ?? branch,
    coAuthor: coAuthorFromSessionUser(session?.user),
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
    diff: gitDiff,
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

  const openPreview = () => {
    if (!draftPreviewUrl) return;
    window.open(draftPreviewUrl, "_blank", "noopener,noreferrer");
  };

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
          <Loading01 className="size-3.5 animate-spin" />
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

  return (
    <>
      <div className="space-y-0.5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HeaderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{headerTitle}</span>
          {summary.count > 1 ? (
            discardAllConfirm ? (
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
            ) : (
              <button
                type="button"
                className="ml-auto shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                onClick={() => setDiscardAllConfirm(true)}
                disabled={isPublishing || isDiscarding}
              >
                {t("thread.publishPopover.discardAll")}
              </button>
            )
          ) : null}
        </div>
        {subLine ? (
          <div className="pl-6 text-xs text-muted-foreground">{subLine}</div>
        ) : null}
      </div>
      <div className="border-t" />

      <div className="flex min-h-0 flex-1 flex-col">
        {loadError ? (
          <p className="px-4 py-6 text-xs text-destructive">{loadError}</p>
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
          <>
            <div className="scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pt-3 pb-2 [scrollbar-width:thin]">
              {renderGroup(
                t("thread.publishPopover.pagesGroup"),
                summary.pages,
              )}
              {renderGroup(
                t("thread.publishPopover.blocksGroup"),
                summary.blocks,
              )}
              {renderGroup(
                t("thread.publishPopover.otherGroup"),
                summary.other,
              )}
            </div>
            <div className="space-y-1.5 border-t px-4 py-3">
              <span className="text-[13px] font-medium">
                {isReview
                  ? t("thread.publishPopover.reviewNote")
                  : t("thread.publishPopover.versionNote")}
              </span>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  isReview
                    ? t("thread.publishPopover.reviewNotePlaceholder")
                    : t("thread.publishPopover.versionNotePlaceholder")
                }
                rows={2}
                className="resize-none text-[13px]"
                disabled={isPublishing}
              />
            </div>
          </>
        )}
      </div>

      {gateRow}

      <div className="border-t" />
      <div className="space-y-2 px-4 py-3">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={openPreview}
            disabled={!draftPreviewUrl}
          >
            <Eye className="size-4" />
            {t("thread.publishPopover.preview")}
          </Button>
          {!isReview && summary.count > 0 && !gate.allowed && !gate.pending ? (
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
                <Loading01 className="size-4 animate-spin" />
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
      </div>
    </>
  );
}
