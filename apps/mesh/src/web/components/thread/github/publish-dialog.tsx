import { useMCPClient } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  ArrowRight,
  Eye,
  GitBranch01,
  Loading01,
  Stars01,
} from "@untitledui/icons";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { GitDiffList } from "./git-diff-list.tsx";
import {
  openPullRequestForBranch,
  squashMergePullRequest,
  type CreatedPullRequest,
} from "./github-pr-api.ts";
import type { PrSummary } from "./use-pr-data.ts";
import { publishToBaseLabel } from "./publish-label.ts";
import {
  countGitChanges,
  discardGitFiles,
  fetchGitDiff,
  fetchGitStatus,
  fetchSuggestCommitMessage,
  hasLocalWorkToPush,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  publishGitChanges,
  PUBLISH_REQUIRES_SUBMIT_TOOLTIP,
  readGitHeadBranch,
  rebaseGitBranch,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

class PublishFlowError extends Error {
  constructor(
    message: string,
    readonly step: "push" | "rebase" | "open-pr" | "merge",
    readonly pr?: CreatedPullRequest,
  ) {
    super(message);
    this.name = "PublishFlowError";
  }
}

export type PublishDialogIntent = "publish" | "open-pr";

export interface PublishDialogProps {
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
  previewUrl?: string | null;
  /**
   * `open-pr` — commits are already on the branch; open a PR from them.
   * `publish` — commit/push local changes (default).
   */
  dialogIntent?: PublishDialogIntent;
  /** Branch HEAD for base…head diff when `dialogIntent` is `open-pr`. */
  headSha?: string | null;
  /** When set, the dialog commits to the branch and updates this open PR. */
  openPullRequest?: PrSummary | null;
  /** Called after commit/push or PR open/merge so the header can refresh. */
  onPullRequestChanged?: () => void | Promise<void>;
  /** Called after a successful publish (squash-merge to base). */
  onPublished?: () => void | Promise<void>;
}

export function PublishDialog(props: PublishDialogProps) {
  const [session, setSession] = useState(0);

  const handleOpenChange = (next: boolean) => {
    if (next) setSession((s) => s + 1);
    props.onOpenChange(next);
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      {props.open ? (
        <PublishDialogBody
          key={session}
          {...props}
          onOpenChange={handleOpenChange}
        />
      ) : null}
    </Dialog>
  );
}

function PublishDialogBody({
  onOpenChange,
  orgSlug,
  orgId,
  virtualMcpId,
  branch,
  baseBranch,
  githubConnectionId,
  owner,
  repo,
  previewUrl,
  dialogIntent = "publish",
  headSha = null,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
}: PublishDialogProps) {
  const githubClient = useMCPClient({
    connectionId: githubConnectionId,
    orgId,
    orgSlug,
  });

  const commitToOpenPr = openPullRequest?.state === "open";
  /** Header "Save changes" — commit/push only, no new PR / merge. */
  const isSaveChangesFlow = dialogIntent === "publish";
  const openPrFromCommits = dialogIntent === "open-pr" && !commitToOpenPr;

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [isLoadingGitDiff, setIsLoadingGitDiff] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishTitle, setPublishTitle] = useState("");
  const [publishBody, setPublishBody] = useState("");
  const [publishError, setPublishError] = useState<string>();
  const [isSubmittingForReview, setIsSubmittingForReview] = useState(false);
  const [isSavingChanges, setIsSavingChanges] = useState(false);
  const [submitForReviewError, setSubmitForReviewError] = useState<string>();
  const [saveChangesError, setSaveChangesError] = useState<string>();
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  const [isDiscardingAll, setIsDiscardingAll] = useState(false);
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);

  const loadStartedRef = useRef(false);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot load on dialog open
  if (!loadStartedRef.current) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot load on dialog open
    loadStartedRef.current = true;
    void (async () => {
      setIsLoadingGitDiff(true);
      setPublishError(undefined);
      setGitDiff(null);
      setPublishTitle("");
      setPublishBody("");
      setSubmitForReviewError(undefined);
      setSaveChangesError(undefined);
      try {
        const diffOpts = openPrFromCommits
          ? {
              base: baseBranch,
              ...(headSha ? { headSha } : {}),
            }
          : undefined;
        const [status, diff] = await Promise.all([
          fetchGitStatus(orgSlug, virtualMcpId, branch),
          fetchGitDiff(orgSlug, virtualMcpId, branch, diffOpts),
        ]);
        setGitStatus(status);
        setGitDiff(diff);
        setPublishTitle(`Changes from ${status.current ?? branch}`);

        setIsGeneratingSuggestion(true);
        fetchSuggestCommitMessage(orgSlug, virtualMcpId, branch, {
          status,
          diff,
        })
          .then((commitSuggestion) => {
            setPublishTitle(commitSuggestion.title);
            setPublishBody(commitSuggestion.body);
          })
          .catch(() => {
            /* best-effort */
          })
          .finally(() => setIsGeneratingSuggestion(false));
      } catch (error) {
        setPublishError(
          error instanceof Error ? error.message : "Failed to load changes.",
        );
      } finally {
        setIsLoadingGitDiff(false);
      }
    })();
  }

  const githubHeadBranch = readGitHeadBranch(gitStatus) ?? branch;
  const publishLabel = publishToBaseLabel(baseBranch);

  const regenerateSuggestion = () => {
    if (!gitStatus || !gitDiff) return;
    setIsGeneratingSuggestion(true);
    void fetchSuggestCommitMessage(orgSlug, virtualMcpId, branch, {
      status: gitStatus,
      diff: gitDiff,
    })
      .then((data) => {
        setPublishTitle(data.title);
        setPublishBody(data.body);
      })
      .catch(() => {
        /* best-effort */
      })
      .finally(() => setIsGeneratingSuggestion(false));
  };

  const changesCount = countGitChanges(gitStatus);
  const diffCount = gitDiff ? Object.keys(gitDiff.diffs).length : changesCount;

  const hasLocalUnpublished = openPrFromCommits
    ? hasLocalWorkToPush(gitStatus)
    : hasUnpublishedWork(gitStatus, gitDiff);
  const canSubmit =
    !isLoadingGitDiff &&
    (isSaveChangesFlow
      ? hasLocalUnpublished
      : hasLocalUnpublished || openPrFromCommits);
  const canPublish = canSubmit && isDecoOnlyDiff(gitDiff);
  const publishDisabledReason =
    canSubmit && !isDecoOnlyDiff(gitDiff)
      ? PUBLISH_REQUIRES_SUBMIT_TOOLTIP
      : null;

  const commitMessage = () =>
    [publishTitle.trim(), publishBody.trim()].filter(Boolean).join("\n\n");

  const handleOpenChange = (nextOpen: boolean) => {
    if (isPublishing || isSubmittingForReview || isSavingChanges) return;
    onOpenChange(nextOpen);
  };

  const handleSaveChanges = async () => {
    setIsSavingChanges(true);
    setSaveChangesError(undefined);
    try {
      const message =
        commitMessage() ||
        publishTitle.trim() ||
        `Changes from ${githubHeadBranch}`;
      await publishGitChanges(orgSlug, virtualMcpId, branch, message);
      toast.success(
        openPullRequest
          ? `Saved changes to PR #${openPullRequest.number}`
          : "Changes saved",
      );
      handleOpenChange(false);
      await onPullRequestChanged?.();
    } catch (error) {
      setSaveChangesError(
        error instanceof Error ? error.message : "Failed to save changes",
      );
    } finally {
      setIsSavingChanges(false);
    }
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishError(undefined);
    let openedPr: CreatedPullRequest | undefined;
    try {
      const prTitle = publishTitle.trim() || `Changes from ${githubHeadBranch}`;
      const prBody = publishBody.trim() || undefined;
      const message = commitMessage() || prTitle;

      if (hasLocalUnpublished) {
        try {
          await publishGitChanges(orgSlug, virtualMcpId, branch, message);
        } catch (error) {
          throw new PublishFlowError(
            error instanceof Error ? error.message : "Failed to push changes",
            "push",
          );
        }
      }

      try {
        await rebaseGitBranch(orgSlug, virtualMcpId, branch, baseBranch);
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error ? error.message : "Failed to rebase onto base",
          "rebase",
        );
      }

      try {
        openedPr = await openPullRequestForBranch(githubClient, {
          owner,
          repo,
          branch: githubHeadBranch,
          title: prTitle,
          body: prBody,
          base: baseBranch,
        });
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error
            ? error.message
            : "Failed to open pull request",
          "open-pr",
        );
      }

      try {
        await squashMergePullRequest(githubClient, {
          owner,
          repo,
          pullNumber: openedPr.number,
          commitTitle: prTitle,
        });
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error
            ? error.message
            : "Failed to merge pull request",
          "merge",
          openedPr,
        );
      }

      toast.success(`Published to ${baseBranch}`);
      handleOpenChange(false);
      setGitDiff(null);
      setPublishTitle("");
      setPublishBody("");
      await onPullRequestChanged?.();
      await onPublished?.();
    } catch (error) {
      if (
        error instanceof PublishFlowError &&
        error.step === "merge" &&
        error.pr
      ) {
        const msg = `Changes were pushed and PR #${error.pr.number} is open, but merge failed: ${error.message}`;
        setPublishError(msg);
        toast.error(msg, {
          action: {
            label: "View PR",
            onClick: () =>
              window.open(error.pr!.htmlUrl, "_blank", "noopener,noreferrer"),
          },
        });
        await onPullRequestChanged?.();
        return;
      }
      setPublishError(
        error instanceof Error ? error.message : "Failed to publish",
      );
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscardFile = async (filepath: string) => {
    try {
      await discardGitFiles(orgSlug, virtualMcpId, branch, [filepath]);
      toast.success(`Discarded changes to ${filepath}`);
      setGitDiff((prev) => {
        if (!prev) return prev;
        const next = { ...prev, diffs: { ...prev.diffs } };
        delete next.diffs[filepath];
        return next;
      });
      const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
      setGitStatus(status);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to discard changes",
      );
    }
  };

  const handleDiscardAll = async () => {
    if (!gitDiff) return;
    setDiscardAllConfirm(false);
    setIsDiscardingAll(true);
    try {
      const allFiles = Object.keys(gitDiff.diffs);
      if (allFiles.length === 0) return;
      await discardGitFiles(orgSlug, virtualMcpId, branch, allFiles);
      toast.success("All changes discarded");
      setGitDiff(null);
      const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
      setGitStatus(status);
      handleOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to discard changes",
      );
    } finally {
      setIsDiscardingAll(false);
    }
  };

  const handleSubmitForReview = async () => {
    setIsSubmittingForReview(true);
    setSubmitForReviewError(undefined);
    try {
      const prTitle = publishTitle.trim() || `Changes from ${githubHeadBranch}`;
      const prBody = publishBody.trim() || undefined;
      const message = commitMessage() || prTitle;

      if (hasLocalUnpublished) {
        await publishGitChanges(orgSlug, virtualMcpId, branch, message);
      }

      const pr = await openPullRequestForBranch(githubClient, {
        owner,
        repo,
        branch: githubHeadBranch,
        title: prTitle,
        body: prBody,
        base: baseBranch,
      });

      toast.success(`Submitted pull request #${pr.number} for review`, {
        action: {
          label: "View on GitHub",
          onClick: () =>
            window.open(pr.htmlUrl, "_blank", "noopener,noreferrer"),
        },
      });
      handleOpenChange(false);
      await onPullRequestChanged?.();
    } catch (error) {
      setSubmitForReviewError(
        error instanceof Error ? error.message : "Failed to submit for review",
      );
    } finally {
      setIsSubmittingForReview(false);
    }
  };

  return (
    <DialogContent className="top-14 left-auto right-4 flex h-[90%] max-h-[85vh] w-[90vw] max-w-[600px] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0">
      <Tabs defaultValue="description" className="flex h-full flex-col gap-0">
        <div className="shrink-0 space-y-3 px-6 pt-5 pb-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {isSaveChangesFlow
                ? "Save changes"
                : openPrFromCommits
                  ? "Submit for review"
                  : publishLabel}
            </p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
              {diffCount} {diffCount === 1 ? "change" : "changes"}{" "}
              {isSaveChangesFlow
                ? "to save"
                : openPrFromCommits
                  ? "in this PR"
                  : "to publish"}
            </div>
          </div>
          {discardAllConfirm ? (
            <div className="flex items-center justify-between gap-3 rounded-md bg-destructive/5 px-3 py-2">
              <span className="text-xs text-destructive">
                Discard all changes? This cannot be undone.
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setDiscardAllConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleDiscardAll}
                  disabled={isDiscardingAll}
                >
                  {isDiscardingAll ? (
                    <Loading01 className="h-3 w-3 animate-spin" />
                  ) : null}
                  Discard all
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <TabsList className="h-8 w-auto" variant="pill">
                <TabsTrigger value="description" className="px-3 text-xs">
                  Description
                </TabsTrigger>
                <TabsTrigger value="changes" className="px-3 text-xs">
                  Changes
                </TabsTrigger>
              </TabsList>
              {diffCount > 0 && !openPrFromCommits && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  onClick={() => setDiscardAllConfirm(true)}
                  disabled={isPublishing || isDiscardingAll || isSavingChanges}
                >
                  Discard all
                </button>
              )}
            </div>
          )}
        </div>

        <div className="border-t" />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoadingGitDiff ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loading01 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading changes…</span>
            </div>
          ) : (
            <>
              <TabsContent value="description" className="mt-0 px-6 py-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {openPrFromCommits ? "Pull request" : "Commit message"}
                    </p>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      disabled={
                        isGeneratingSuggestion ||
                        isPublishing ||
                        isSubmittingForReview ||
                        isSavingChanges
                      }
                      onClick={regenerateSuggestion}
                    >
                      {isGeneratingSuggestion ? (
                        <Loading01 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Stars01 className="h-3 w-3" />
                      )}
                      {isGeneratingSuggestion ? "Generating…" : "Regenerate"}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="publish-title"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Title
                    </label>
                    <Input
                      id="publish-title"
                      value={publishTitle}
                      onChange={(e) => setPublishTitle(e.target.value)}
                      placeholder={
                        isGeneratingSuggestion ? "Generating…" : "Commit title…"
                      }
                      disabled={
                        isPublishing ||
                        isSubmittingForReview ||
                        isSavingChanges ||
                        isGeneratingSuggestion
                      }
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="publish-body"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Description
                    </label>
                    <Textarea
                      id="publish-body"
                      value={publishBody}
                      onChange={(e) => setPublishBody(e.target.value)}
                      placeholder={
                        isGeneratingSuggestion
                          ? "Generating…"
                          : "Description (optional)…"
                      }
                      disabled={
                        isPublishing ||
                        isSubmittingForReview ||
                        isSavingChanges ||
                        isGeneratingSuggestion
                      }
                      rows={5}
                      className="resize-none text-sm"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Branch: <span className="font-mono">{branch}</span>
                    {isSaveChangesFlow ? (
                      <>
                        {" · "}
                        <span className="text-foreground/80">
                          {commitToOpenPr
                            ? `Commits and pushes to update open PR #${openPullRequest.number}.`
                            : "Commits and pushes to the branch without opening a pull request."}
                        </span>
                      </>
                    ) : (
                      <>
                        {" → "}
                        <span className="font-mono">{baseBranch}</span>
                        {" · "}
                        <span className="text-foreground/80">
                          Submit for review keeps changes on the branch;{" "}
                          {publishLabel} squash-merges into {baseBranch}.
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="changes" className="mt-0">
                <GitDiffList diff={gitDiff} onDiscardFile={handleDiscardFile} />
              </TabsContent>
            </>
          )}
        </div>

        <div className="shrink-0 border-t">
          <button
            type="button"
            className="flex w-full items-center justify-between px-6 py-3.5 text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
            onClick={() => {
              if (previewUrl) {
                window.open(previewUrl, "_blank", "noopener,noreferrer");
              }
            }}
            disabled={!previewUrl}
          >
            <span className="flex items-center gap-3">
              <Eye className="h-4 w-4 text-muted-foreground" />
              Visit preview
            </span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="shrink-0 border-t px-6 py-3">
          {isSaveChangesFlow ? (
            <>
              <Button
                type="button"
                className="w-full"
                onClick={handleSaveChanges}
                disabled={!canSubmit || isSavingChanges}
              >
                {isSavingChanges ? (
                  <Loading01 className="h-4 w-4 animate-spin" />
                ) : null}
                Save changes
              </Button>
              {saveChangesError && (
                <p className="mt-2 text-xs text-destructive">
                  {saveChangesError}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={handleSubmitForReview}
                  disabled={!canSubmit || isSubmittingForReview || isPublishing}
                >
                  {isSubmittingForReview ? (
                    <Loading01 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitBranch01 className="h-4 w-4" />
                  )}
                  Submit for review
                </Button>
                <PublishButton
                  label={publishLabel}
                  canPublish={canPublish}
                  disabledReason={publishDisabledReason}
                  isPublishing={isPublishing}
                  isSubmittingForReview={isSubmittingForReview}
                  onPublish={handlePublish}
                />
              </div>
              {submitForReviewError && (
                <p className="mt-2 text-xs text-destructive">
                  {submitForReviewError}
                </p>
              )}
              {publishError && (
                <p className="mt-2 text-xs text-destructive">{publishError}</p>
              )}
            </>
          )}
        </div>
      </Tabs>
    </DialogContent>
  );
}

function PublishButton({
  label,
  canPublish,
  disabledReason,
  isPublishing,
  isSubmittingForReview,
  onPublish,
}: {
  label: string;
  canPublish: boolean;
  disabledReason: string | null;
  isPublishing: boolean;
  isSubmittingForReview: boolean;
  onPublish: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="success"
      className="flex-1"
      onClick={onPublish}
      disabled={!canPublish || isPublishing || isSubmittingForReview}
    >
      {isPublishing ? <Loading01 className="h-4 w-4 animate-spin" /> : null}
      {label}
    </Button>
  );

  if (!disabledReason) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex flex-1">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
