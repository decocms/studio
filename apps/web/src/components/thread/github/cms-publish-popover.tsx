/**
 * Fast Preview's content-first publish surface: an anchored popover (modal on
 * narrow viewports) that renders the diff as pages and blocks by name, an
 * editable version note, and the review gate as a visible check row — no git
 * vocabulary. The publish flow underneath is the same push → sync → PR →
 * squash-merge sequence as {@link PublishDialog}, which vibecoding mode (and
 * the request-approval intent) keeps unchanged.
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
} from "@untitledui/icons";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { formatTimeAgo } from "@/lib/format-time.ts";
import { useSaveBlock } from "@/components/sections-editor/use-save-block.ts";
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
  revertFieldAtPath,
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
import { useLastPublishedPr, type PrSummary } from "./use-pr-data.ts";
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

function statusChip(status: PublishChangeStatus, t: ReturnType<typeof useT>) {
  const label = statusLabel(status, t);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "new" && "bg-success/10 text-success",
        status === "edited" && "bg-warning/10 text-warning",
        status === "removed" && "bg-destructive/10 text-destructive",
      )}
    >
      {label}
    </span>
  );
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

/** Hard byte cap only — visual truncation is the renderer's line-clamp. */
function renderFieldValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }
  const raw = JSON.stringify(value);
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

function CmsPublishBody({
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
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [note, setNote] = useState("");
  const [discardConfirmId, setDiscardConfirmId] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rawJsonId, setRawJsonId] = useState<string | null>(null);

  const loadStartedRef = useRef(false);

  const summary = summarizePublishChanges(gitDiff);

  const loadGitState = async () => {
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
    const diff = combinePublishDiffs(baseDiff, workingDiff);
    setGitStatus(status);
    setGitDiff(diff);
    return { status, diff };
  };

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot load on open
  if (!loadStartedRef.current) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot load on open
    loadStartedRef.current = true;
    void (async () => {
      setIsLoading(true);
      setLoadError(undefined);
      try {
        const { diff } = await loadGitState();
        setNote(buildAutoNote(summarizePublishChanges(diff)));
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedLoad"),
        );
      } finally {
        setIsLoading(false);
      }
    })();
  }

  const { gate } = useResolvedPublishGate({
    orgSlug,
    virtualMcpId,
    branch,
    status: gitStatus,
    diff: gitDiff,
    policy: publishPolicy,
    judgeEnabled: true,
  });

  const lastPublish = useLastPublishedPr({
    orgId,
    orgSlug,
    connectionId: githubConnectionId,
    owner,
    repo,
    base: baseBranch,
  });

  const commitToOpenPr = openPullRequest?.state === "open";
  const existingOpenPr = commitToOpenPr
    ? { number: openPullRequest.number, htmlUrl: openPullRequest.htmlUrl }
    : undefined;
  const githubHeadBranch = readGitHeadBranch(gitStatus) ?? branch;

  const canPublish =
    !isLoading && !isPublishing && summary.count > 0 && gate.allowed;

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
      await loadGitState();
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
      await loadGitState();
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

  const handleDiscardField = async (
    change: PublishChange,
    path: (string | number)[],
    label: string,
  ) => {
    if (!change.blockKey || !change.toJson) return;
    const updated = revertFieldAtPath(change.toJson, change.fromJson, path);
    if (!updated) {
      toast.error(t("thread.publishPopover.failedDiscard"));
      return;
    }
    try {
      await saveBlock.mutateAsync({ blockKey: change.blockKey, data: updated });
      toast.success(
        t("thread.publishPopover.discardedField", { field: label }),
      );
      await loadGitState();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("thread.publishPopover.failedDiscard"),
      );
    }
  };

  const headerTitle = destinationHost
    ? t("thread.publishPopover.publishTo", { host: destinationHost })
    : t("thread.publishPopover.publish");

  const lastPublishLine = (() => {
    const pr = lastPublish.data;
    if (!pr?.mergedAt) return null;
    const when = formatTimeAgo(new Date(pr.mergedAt));
    const name = lastPublishAttribution(pr);
    return name
      ? t("thread.publishPopover.lastPublishedBy", { when, name })
      : t("thread.publishPopover.lastPublished", { when });
  })();

  const changesReadyLine =
    summary.count === 1
      ? t("thread.publishPopover.changeReady")
      : t("thread.publishPopover.changesReady", { count: summary.count });

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
    const canExpand = change.status === "edited" && change.sections.length > 0;
    const canDiscardFields =
      change.status === "edited" && !!change.blockKey && !!change.toJson;
    const rawDiff: GitDiffResult = {
      diffs: Object.fromEntries(
        change.filepaths.flatMap((p) => {
          const entry = gitDiff?.diffs[p];
          return entry ? [[p, entry] as const] : [];
        }),
      ),
    };
    const toggleExpanded = () => {
      setExpandedId(expanded ? null : id);
      setRawJsonId(null);
    };

    return (
      <div
        key={id}
        className="rounded-lg border bg-card px-3 py-2.5"
        data-change-id={id}
      >
        <div className="flex items-center gap-2.5">
          {changeIcon(change, t)}
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 text-left",
              canExpand && "cursor-pointer",
            )}
            onClick={canExpand ? toggleExpanded : undefined}
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
                onClick={() => setDiscardConfirmId(null)}
              >
                {t("thread.publishDialog.cancel")}
              </button>
              <button
                type="button"
                className="text-xs font-medium text-destructive disabled:opacity-50"
                onClick={() => handleDiscard(change)}
                disabled={isDiscarding}
              >
                {t("thread.publishPopover.discard")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
              onClick={() => setDiscardConfirmId(id)}
              disabled={isPublishing || isDiscarding}
            >
              {t("thread.publishPopover.discard")}
            </button>
          )}
          {canExpand ? (
            <button
              type="button"
              className="flex shrink-0 items-center"
              onClick={toggleExpanded}
              aria-expanded={expanded}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
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
          <div className="mt-2 space-y-2 border-t pt-2.5">
            <div className="max-h-56 space-y-3 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              {rawJsonId === id ? (
                <div className="-mx-3 overflow-x-auto">
                  <GitDiffList diff={rawDiff} rowClassName="px-3" />
                </div>
              ) : (
                change.sections.map((section, sectionIndex) => (
                  <div
                    key={`${sectionIndex}-${section.name}`}
                    className="space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">
                        {section.name}
                      </span>
                      {section.status !== "edited"
                        ? statusChip(section.status, t)
                        : null}
                    </div>
                    {section.fields.map((field) => (
                      <div
                        key={field.path.join(".")}
                        className="space-y-1 pl-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-muted-foreground">
                            {field.label}
                          </span>
                          {canDiscardFields ? (
                            <button
                              type="button"
                              className="text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                              onClick={() =>
                                handleDiscardField(
                                  change,
                                  field.path,
                                  field.label,
                                )
                              }
                              disabled={saveBlock.isPending || isPublishing}
                            >
                              {t("thread.publishPopover.discard")}
                            </button>
                          ) : null}
                        </div>
                        <div className="line-clamp-2 rounded-md bg-destructive/5 px-2 py-1 text-xs break-words whitespace-pre-wrap text-destructive/80 line-through [overflow-wrap:anywhere]">
                          {renderFieldValue(field.from)}
                        </div>
                        <div className="line-clamp-3 rounded-md bg-success/5 px-2 py-1 text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {renderFieldValue(field.to)}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setRawJsonId(rawJsonId === id ? null : id)}
            >
              {rawJsonId === id
                ? t("thread.publishPopover.back")
                : t("thread.publishPopover.viewRawJson")}
            </button>
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
    if (isLoading || summary.count === 0) return null;
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
          {!isLoading && summary.count > 1 ? (
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
        <div className="pl-6 text-xs text-muted-foreground">
          {[lastPublishLine, isLoading ? null : changesReadyLine]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="border-t" />

      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loading01 className="size-4 animate-spin" />
            <span className="text-sm">
              {t("thread.publishDialog.loadingChanges")}
            </span>
          </div>
        ) : loadError ? (
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
          {!isLoading && summary.count > 0 && !gate.allowed && !gate.pending ? (
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
