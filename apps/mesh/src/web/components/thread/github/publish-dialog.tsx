import { DiffEditor, loader } from "@monaco-editor/react";
import { useMCPClient } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
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
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ArrowRight,
  ChevronRight,
  Eye,
  File06,
  GitBranch01,
  Loading01,
  DotsHorizontal,
  Stars01,
} from "@untitledui/icons";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { getLanguageFromPath } from "../../sandbox/preview/file-explorer/utils.ts";
import {
  openPullRequestForBranch,
  squashMergePullRequest,
  type CreatedPullRequest,
} from "./github-pr-api.ts";
import {
  countGitChanges,
  discardGitFiles,
  fetchGitDiff,
  fetchGitStatus,
  fetchSuggestCommitMessage,
  hasUnpublishedWork,
  isDecoOnlyDiff,
  publishGitChanges,
  PUBLISH_REQUIRES_SUBMIT_TOOLTIP,
  readGitHeadBranch,
  rebaseGitBranch,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
  },
});

function editorTheme(): "vs" | "vs-dark" {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

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
  onPullRequestChanged,
  onPublished,
}: PublishDialogProps) {
  const githubClient = useMCPClient({
    connectionId: githubConnectionId,
    orgId,
    orgSlug,
  });

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [isLoadingGitDiff, setIsLoadingGitDiff] = useState(true);
  const [expandedDiffFile, setExpandedDiffFile] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishTitle, setPublishTitle] = useState("");
  const [publishBody, setPublishBody] = useState("");
  const [publishError, setPublishError] = useState<string>();
  const [isSubmittingForReview, setIsSubmittingForReview] = useState(false);
  const [submitForReviewError, setSubmitForReviewError] = useState<string>();
  const [discardConfirmFile, setDiscardConfirmFile] = useState<string | null>(
    null,
  );
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
      setExpandedDiffFile(null);
      setGitDiff(null);
      setPublishTitle("");
      setPublishBody("");
      setSubmitForReviewError(undefined);
      try {
        const [status, diff] = await Promise.all([
          fetchGitStatus(orgSlug, virtualMcpId, branch),
          fetchGitDiff(orgSlug, virtualMcpId, branch),
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
  const theme = editorTheme();

  const canSubmit = !isLoadingGitDiff && hasUnpublishedWork(gitStatus, gitDiff);
  const canPublish = canSubmit && isDecoOnlyDiff(gitDiff);
  const publishDisabledReason =
    canSubmit && !isDecoOnlyDiff(gitDiff)
      ? PUBLISH_REQUIRES_SUBMIT_TOOLTIP
      : null;

  const commitMessage = () =>
    [publishTitle.trim(), publishBody.trim()].filter(Boolean).join("\n\n");

  const handleOpenChange = (nextOpen: boolean) => {
    if (isPublishing || isSubmittingForReview) return;
    onOpenChange(nextOpen);
    if (!nextOpen) setExpandedDiffFile(null);
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishError(undefined);
    let openedPr: CreatedPullRequest | undefined;
    try {
      const prTitle = publishTitle.trim() || `Changes from ${githubHeadBranch}`;
      const prBody = publishBody.trim() || undefined;
      const message = commitMessage() || prTitle;

      try {
        await publishGitChanges(orgSlug, virtualMcpId, branch, message);
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error ? error.message : "Failed to push changes",
          "push",
        );
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
            onClick: () => window.open(error.pr!.htmlUrl, "_blank", "noopener"),
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
    setDiscardConfirmFile(null);
    try {
      await discardGitFiles(orgSlug, virtualMcpId, branch, [filepath]);
      toast.success(`Discarded changes to ${filepath}`);
      setGitDiff((prev) => {
        if (!prev) return prev;
        const next = { ...prev, diffs: { ...prev.diffs } };
        delete next.diffs[filepath];
        return next;
      });
      if (expandedDiffFile === filepath) setExpandedDiffFile(null);
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
      setExpandedDiffFile(null);
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

      await publishGitChanges(orgSlug, virtualMcpId, branch, message);

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
          onClick: () => window.open(pr.htmlUrl, "_blank", "noopener"),
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
            <p className="text-xs font-medium text-muted-foreground">Publish</p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
              {diffCount} {diffCount === 1 ? "change" : "changes"} to publish
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
              {diffCount > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  onClick={() => setDiscardAllConfirm(true)}
                  disabled={isPublishing || isDiscardingAll}
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
                    <p className="text-sm font-medium">Commit message</p>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      disabled={
                        isGeneratingSuggestion ||
                        isPublishing ||
                        isSubmittingForReview
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
                        isGeneratingSuggestion
                      }
                      rows={5}
                      className="resize-none text-sm"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Branch: <span className="font-mono">{branch}</span>
                    {" → "}
                    <span className="font-mono">{baseBranch}</span>
                    {" · "}
                    <span className="text-foreground/80">
                      Submit for review keeps changes on the branch; Publish
                      squash-merges into {baseBranch}.
                    </span>
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="changes" className="mt-0">
                {gitDiff && Object.keys(gitDiff.diffs).length === 0 && (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    No file changes in the working tree
                  </div>
                )}
                {gitDiff && Object.keys(gitDiff.diffs).length > 0 && (
                  <div className="divide-y">
                    {Object.entries(gitDiff.diffs).map(
                      ([filepath, { from, to }]) => {
                        const isExpanded = expandedDiffFile === filepath;
                        const isNew = from === null;
                        const isDeleted = to === null;
                        const raw = filepath.startsWith("/")
                          ? filepath.slice(1)
                          : filepath;
                        const lastSlash = raw.lastIndexOf("/");
                        const basename =
                          lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
                        const directory =
                          lastSlash >= 0 ? raw.slice(0, lastSlash) : null;
                        const language = getLanguageFromPath(filepath);
                        const dotColor = isNew
                          ? "bg-green-500"
                          : isDeleted
                            ? "bg-red-500"
                            : "bg-amber-500";

                        return (
                          <div key={filepath}>
                            <div className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30">
                              <button
                                type="button"
                                className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-transform hover:text-foreground"
                                onClick={() =>
                                  setExpandedDiffFile(
                                    isExpanded ? null : filepath,
                                  )
                                }
                              >
                                <ChevronRight
                                  className={cn(
                                    "h-3.5 w-3.5 transition-transform",
                                    isExpanded && "rotate-90",
                                  )}
                                />
                              </button>
                              <div
                                className={cn(
                                  "h-2.5 w-2.5 shrink-0 rounded-full",
                                  dotColor,
                                )}
                              />
                              <File06 className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {basename}
                              </span>
                              {directory && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {directory}
                                </span>
                              )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    <DotsHorizontal className="h-3.5 w-3.5" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onSelect={() =>
                                      setDiscardConfirmFile(filepath)
                                    }
                                  >
                                    Discard changes
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>

                            {discardConfirmFile === filepath && (
                              <div className="flex items-center justify-between gap-3 border-t bg-destructive/5 px-6 py-2.5">
                                <span className="text-xs text-destructive">
                                  Discard all changes to{" "}
                                  <span className="font-medium">
                                    {basename}
                                  </span>
                                  ? This cannot be undone.
                                </span>
                                <div className="flex shrink-0 items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setDiscardConfirmFile(null)}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => handleDiscardFile(filepath)}
                                  >
                                    Discard
                                  </Button>
                                </div>
                              </div>
                            )}

                            {isExpanded && (
                              <div className="border-t">
                                <DiffEditor
                                  original={from ?? ""}
                                  modified={to ?? ""}
                                  language={language}
                                  theme={theme}
                                  height="380px"
                                  options={{
                                    readOnly: true,
                                    renderSideBySide: false,
                                    minimap: { enabled: false },
                                    scrollBeyondLastLine: false,
                                    fontSize: 12,
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                )}
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
        </div>
      </Tabs>
    </DialogContent>
  );
}

function PublishButton({
  canPublish,
  disabledReason,
  isPublishing,
  isSubmittingForReview,
  onPublish,
}: {
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
      Publish
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
