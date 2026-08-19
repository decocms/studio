/**
 * Fast Preview's content-first publish surface: an anchored popover (modal on
 * narrow viewports) that renders the diff as pages and blocks by name, an
 * editable version note, and the review gate as a visible check row — no git
 * vocabulary. The publish flow underneath is the same push → sync → PR →
 * squash-merge sequence as {@link PublishDialog}, which vibecoding mode (and
 * the request-approval intent) keeps unchanged.
 */

import { useMCPClient } from "@/sdk";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { Dialog, DialogContent } from "@decocms/ui/components/dialog.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@decocms/ui/components/popover.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Eye,
  File06,
  Globe01,
  LayoutAlt01,
  Loading01,
  Trash01,
} from "@untitledui/icons";
import {
  Suspense,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import { GitDiffList } from "./git-diff-list.tsx";
import {
  openPullRequestForBranch,
  squashMergePullRequest,
  type CreatedPullRequest,
} from "./github-pr-api.ts";
import { lastPublishAttribution } from "./pr-attribution.ts";
import {
  buildAutoNote,
  countPageSections,
  summarizePublishChanges,
  type PublishChange,
  type PublishChangeStatus,
} from "./publish-change-summary.ts";
import {
  combinePublishDiffs,
  discardGitFiles,
  fetchGitDiff,
  fetchGitStatus,
  hasGitLocalWork,
  publishGitChanges,
  readGitHeadBranch,
  rebaseGitBranch,
  type GitDiffResult,
  type GitStatus,
  type PublishPolicy,
} from "./sandbox-git-api.ts";
import { fetchLastPublishedPr, type PrSummary } from "./use-pr-data.ts";
import { useResolvedPublishGate } from "@/components/sandbox/hooks/use-publish-gate.ts";

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
  /** Blocked gate: route to the existing request-approval (open PR) dialog. */
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
        className="flex max-h-[min(720px,85vh)] w-[420px] flex-col gap-0 overflow-hidden p-0"
      >
        <CmsPublishBody {...props} publishLockRef={publishLockRef} />
      </PopoverContent>
    </Popover>
  );
}

class PublishStepError extends Error {
  constructor(
    message: string,
    readonly step: "push" | "sync" | "open-pr" | "merge",
    readonly pr?: CreatedPullRequest,
  ) {
    super(message);
    this.name = "PublishStepError";
  }
}

function statusLabel(status: PublishChangeStatus, t: ReturnType<typeof useT>) {
  return status === "new"
    ? t("thread.publishPopover.chipNew")
    : status === "removed"
      ? t("thread.publishPopover.chipRemoved")
      : t("thread.publishPopover.chipEdited");
}

/** Status is carried by the icon color (lime = added); the title names it for
 *  anyone who can't rely on color alone. */
function changeIcon(change: PublishChange, t: ReturnType<typeof useT>) {
  const Icon = change.kind === "block" ? LayoutAlt01 : File06;
  return (
    <span title={statusLabel(change.status, t)} className="flex shrink-0">
      <Icon
        className={cn(
          "size-4",
          change.status === "new" && "text-brand",
          change.status === "edited" && "text-warning",
          change.status === "removed" && "text-destructive",
        )}
      />
    </span>
  );
}

/** Stable identity for a card across summary recomputes. */
function changeId(change: PublishChange): string {
  return change.blockKey ?? change.filepaths[0] ?? change.name;
}

/** One suspense load: git state and last-publish arrive together, so the
 *  popover goes straight from a single loading state to the final render.
 *  Failures land in `loadError` / a null `lastPublishedPr` (rendered inline)
 *  rather than throwing to an error boundary. */
interface PublishStateData {
  status: GitStatus | null;
  diff: GitDiffResult | null;
  lastPublishedPr: PrSummary | null;
  loadError: string | null;
}

function publishStateQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  baseBranch: string,
) {
  return [
    "cms-publish-popover-state",
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
  ] as const;
}

function CmsPublishBody(
  props: CmsPublishPopoverProps & {
    publishLockRef: React.MutableRefObject<boolean>;
  },
) {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loading01 className="size-4 animate-spin" />
          <span className="text-sm">
            {t("thread.publishDialog.loadingChanges")}
          </span>
        </div>
      }
    >
      <CmsPublishContent {...props} />
    </Suspense>
  );
}

function CmsPublishContent({
  publishLockRef,
  onOpenChange,
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
  const coAuthor = coAuthorFromSessionUser(session?.user);

  const publishState = useSuspenseQuery<PublishStateData>({
    queryKey: publishStateQueryKey(orgSlug, virtualMcpId, branch, baseBranch),
    queryFn: async (): Promise<PublishStateData> => {
      const lastPublishedPromise = fetchLastPublishedPr(githubClient, {
        owner,
        repo,
        base: baseBranch,
      }).catch(() => null);
      try {
        const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
        const baseDiff =
          (status.aheadOfBase ?? 0) > 0
            ? await fetchGitDiff(orgSlug, virtualMcpId, branch, {
                base: baseBranch,
              })
            : null;
        const workingDiff = hasGitLocalWork(status)
          ? await fetchGitDiff(orgSlug, virtualMcpId, branch)
          : null;
        return {
          status,
          diff: combinePublishDiffs(baseDiff, workingDiff),
          lastPublishedPr: await lastPublishedPromise,
          loadError: null,
        };
      } catch (error) {
        return {
          status: null,
          diff: null,
          lastPublishedPr: await lastPublishedPromise,
          loadError: error instanceof Error ? error.message : String(error),
        };
      }
    },
    staleTime: 0,
    gcTime: 0,
  });
  const {
    status: gitStatus,
    diff: gitDiff,
    lastPublishedPr,
    loadError,
  } = publishState.data;

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [note, setNote] = useState(() =>
    gitDiff ? buildAutoNote(summarizePublishChanges(gitDiff)) : "",
  );
  const [discardConfirmId, setDiscardConfirmId] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const summary = summarizePublishChanges(gitDiff);

  const { gate } = useResolvedPublishGate({
    orgSlug,
    virtualMcpId,
    branch,
    status: gitStatus,
    diff: gitDiff,
    policy: publishPolicy,
    judgeEnabled: true,
  });

  const commitToOpenPr = openPullRequest?.state === "open";
  const existingOpenPr = commitToOpenPr
    ? { number: openPullRequest.number, htmlUrl: openPullRequest.htmlUrl }
    : undefined;
  const githubHeadBranch = readGitHeadBranch(gitStatus) ?? branch;

  const canPublish = !isPublishing && summary.count > 0 && gate.allowed;

  const noteTitle = () =>
    note.trim().split("\n")[0]?.trim() ||
    t("thread.publishDialog.changesFrom", { branch: githubHeadBranch });
  const noteBody = () => {
    const lines = note.trim().split("\n");
    return lines.slice(1).join("\n").trim() || undefined;
  };

  const handlePublish = async () => {
    publishLockRef.current = true;
    setIsPublishing(true);
    setPublishError(undefined);
    let openedPr: CreatedPullRequest | undefined;
    try {
      const title = noteTitle();
      const body = noteBody();
      const message = [title, body].filter(Boolean).join("\n\n");

      try {
        await publishGitChanges(orgSlug, virtualMcpId, branch, message);
      } catch (error) {
        throw new PublishStepError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedPushChanges"),
          "push",
        );
      }
      try {
        await rebaseGitBranch(orgSlug, virtualMcpId, branch, baseBranch, {
          onConflict: "branch-wins",
        });
      } catch (error) {
        throw new PublishStepError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedRebase"),
          "sync",
        );
      }
      try {
        openedPr = await openPullRequestForBranch(githubClient, {
          owner,
          repo,
          branch: githubHeadBranch,
          title,
          body,
          base: baseBranch,
          coAuthor,
          existing: existingOpenPr,
        });
      } catch (error) {
        throw new PublishStepError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedOpenPullRequest"),
          "open-pr",
        );
      }
      try {
        await squashMergePullRequest(githubClient, {
          owner,
          repo,
          pullNumber: openedPr.number,
          commitTitle: title,
          commitMessage: body,
          coAuthor,
        });
      } catch (error) {
        throw new PublishStepError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedMergePullRequest"),
          "merge",
          openedPr,
        );
      }

      toast.success(
        destinationHost
          ? t("thread.publishPopover.publishedTo", { host: destinationHost })
          : t("thread.publishDialog.publishedTo", { baseBranch }),
      );
      onOpenChange(false);
      await onPullRequestChanged?.();
      await onPublished?.();
    } catch (error) {
      if (
        error instanceof PublishStepError &&
        error.step === "merge" &&
        error.pr
      ) {
        const msg = t("thread.publishDialog.mergeFailed", {
          prNumber: error.pr.number,
          message: error.message,
        });
        setPublishError(msg);
        toast.error(msg, {
          action: {
            label: t("thread.publishDialog.viewPr"),
            onClick: () =>
              window.open(error.pr!.htmlUrl, "_blank", "noopener,noreferrer"),
          },
        });
        await onPullRequestChanged?.();
        return;
      }
      setPublishError(
        error instanceof Error
          ? error.message
          : t("thread.publishDialog.failedPublish"),
      );
    } finally {
      publishLockRef.current = false;
      setIsPublishing(false);
    }
  };

  const handleDiscard = async (change: PublishChange) => {
    setDiscardConfirmId(null);
    setIsDiscarding(true);
    try {
      await discardGitFiles(orgSlug, virtualMcpId, branch, change.filepaths);
      toast.success(
        t("thread.publishPopover.discarded", { name: change.name }),
      );
      await publishState.refetch();
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

  const handleDiscardAll = async () => {
    if (!gitDiff) return;
    setDiscardAllConfirm(false);
    setIsDiscarding(true);
    try {
      const allFiles = Object.keys(gitDiff.diffs);
      if (allFiles.length === 0) return;
      await discardGitFiles(orgSlug, virtualMcpId, branch, allFiles);
      toast.success(t("thread.publishDialog.allChangesDiscarded"));
      await publishState.refetch();
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

  const headerTitle =
    summary.count === 0
      ? t("thread.publishPopover.publish")
      : summary.count === 1
        ? t("thread.publishPopover.publishOneInProduction")
        : t("thread.publishPopover.publishCountInProduction", {
            count: summary.count,
          });

  const lastPublishLine = (() => {
    const pr = lastPublishedPr;
    if (!pr?.mergedAt) return null;
    const when = formatTimeAgo(new Date(pr.mergedAt));
    const name = lastPublishAttribution(pr);
    return name
      ? t("thread.publishPopover.lastPublishedBy", { when, name })
      : t("thread.publishPopover.lastPublished", { when });
  })();

  const publishLabel =
    summary.count === 1
      ? t("thread.publishPopover.publishOne")
      : summary.count > 1
        ? t("thread.publishPopover.publishCount", { count: summary.count })
        : t("thread.publishPopover.publish");

  const openPreview = () => {
    if (!draftPreviewUrl) return;
    window.open(draftPreviewUrl, "_blank", "noopener,noreferrer");
  };

  const renderCard = (change: PublishChange) => {
    const id = changeId(change);
    const confirming = discardConfirmId === id;
    const expanded = expandedId === id;
    const detail =
      change.kind === "page"
        ? change.pagePath
        : change.kind === "block"
          ? change.isSiteApp
            ? t("thread.publishPopover.siteConfiguration")
            : t("thread.publishPopover.globalSection")
          : null;
    const subLines =
      change.kind === "page" && change.status === "new"
        ? [
            t("thread.publishPopover.newPageSections", {
              count: countPageSections(change.toJson),
            }),
          ]
        : change.sections.map((section) =>
            section.fields.length > 0
              ? `${section.name} — ${section.fields
                  .slice(0, 4)
                  .map((f) => f.label)
                  .join(", ")}`
              : section.name,
          );
    const rawDiff: GitDiffResult = {
      diffs: Object.fromEntries(
        change.filepaths.flatMap((p) => {
          const entry = gitDiff?.diffs[p];
          return entry ? [[p, entry] as const] : [];
        }),
      ),
    };
    const canExpand = Object.keys(rawDiff.diffs).length > 0;
    const toggleExpanded = () => setExpandedId(expanded ? null : id);

    // Collapsed card = one big expand target; inner controls stop propagation.
    return (
      <div
        key={id}
        className={cn(
          "rounded-lg border bg-card px-3 py-2.5",
          canExpand && !expanded && "cursor-pointer",
        )}
        data-change-id={id}
        onClick={canExpand && !expanded ? toggleExpanded : undefined}
      >
        <div
          className={cn(
            "flex items-center gap-2.5",
            canExpand && "cursor-pointer",
          )}
          onClick={
            canExpand
              ? (e) => {
                  e.stopPropagation();
                  toggleExpanded();
                }
              : undefined
          }
        >
          {changeIcon(change, t)}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            disabled={!canExpand}
            aria-expanded={canExpand ? expanded : undefined}
          >
            <span className="truncate text-sm font-medium">{change.name}</span>
            {detail ? (
              <span className="truncate text-xs text-muted-foreground">
                {detail}
              </span>
            ) : null}
          </button>
          {confirming ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setDiscardConfirmId(null);
                }}
              >
                {t("thread.publishDialog.cancel")}
              </button>
              <button
                type="button"
                className="text-xs font-medium text-destructive disabled:opacity-50"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDiscard(change);
                }}
                disabled={isDiscarding}
              >
                {t("thread.publishPopover.discard")}
              </button>
            </div>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("thread.publishPopover.discard")}
                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDiscardConfirmId(id);
                    }}
                    disabled={isPublishing || isDiscarding}
                  >
                    <Trash01 className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("thread.publishPopover.discard")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {canExpand ? (
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
          ) : null}
        </div>
        {!expanded && subLines.length > 0 ? (
          <div className="mt-1 space-y-0.5 pl-[26px] text-xs text-muted-foreground">
            {subLines.map((line, lineIndex) => (
              <div key={`${lineIndex}-${line}`} className="truncate">
                {line}
              </div>
            ))}
          </div>
        ) : null}
        {expanded ? (
          <div className="-mx-3 mt-2 border-t pt-1">
            <div className="max-h-72 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              <GitDiffList diff={rawDiff} hideFileRows editorHeight="220px" />
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderGroup = (label: string, changes: PublishChange[]) => {
    if (changes.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <div className="px-0.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </div>
        {changes.map(renderCard)}
      </div>
    );
  };

  const gateRow = (() => {
    if (summary.count === 0) return null;
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
          <Globe01 className="size-4 shrink-0 text-muted-foreground" />
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
                  onClick={handleDiscardAll}
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
        {lastPublishLine ? (
          <div className="pl-6 text-xs text-muted-foreground">
            {lastPublishLine}
          </div>
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
              {t("thread.publishPopover.everythingLive")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("thread.publishPopover.emptyHint")}
            </p>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pt-3 pb-2 [scrollbar-width:thin]">
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
                {t("thread.publishPopover.versionNote")}
              </span>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("thread.publishPopover.versionNotePlaceholder")}
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
          {summary.count > 0 && !gate.allowed && !gate.pending ? (
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                onOpenChange(false);
                onRequestApproval();
              }}
              disabled={isPublishing}
            >
              {t("thread.publishPopover.requestApproval")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="brand"
              className="flex-1"
              onClick={handlePublish}
              disabled={!canPublish}
            >
              {isPublishing ? (
                <Loading01 className="size-4 animate-spin" />
              ) : null}
              {isPublishing
                ? t("thread.publishPopover.publishing")
                : publishLabel}
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
