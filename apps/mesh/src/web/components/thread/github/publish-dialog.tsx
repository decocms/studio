import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
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
import { useT } from "@/web/i18n/use-t.ts";
import { authClient } from "@/web/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { GitDiffList } from "./git-diff-list.tsx";
import {
  openPullRequestForBranch,
  squashMergePullRequest,
  type CreatedPullRequest,
} from "./github-pr-api.ts";
import type { PrSummary } from "./use-pr-data.ts";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { publishToBaseLabel } from "./publish-label.ts";
import { useSmartReviewVerdict } from "@/web/components/sandbox/hooks/use-smart-review-verdict.ts";
import {
  canPublishDirectly,
  combinePublishDiffs,
  countGitChanges,
  discardGitFiles,
  fetchGitDiff,
  fetchGitStatus,
  fetchSuggestCommitMessage,
  hasGitLocalWork,
  hasLocalWorkToPush,
  hasUnpublishedWork,
  isSandboxUnreachable,
  needsSmartReviewJudgment,
  publishGitChanges,
  readGitHeadBranch,
  rebaseGitBranch,
  shouldUseBaseDiff,
  smartReviewGate,
  type GitDiffResult,
  type GitStatus,
  type PublishPolicy,
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

export type PublishDialogIntent = "open-pr" | "publish-only";

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
  /** The code agent's publish policy — gates the direct Publish button. */
  publishPolicy: PublishPolicy;
  /**
   * `open-pr` — push local work and open a PR for review (default).
   * `publish-only` — direct publish to base; single green Publish button.
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
  publishPolicy,
  dialogIntent = "open-pr",
  headSha = null,
  openPullRequest = null,
  onPullRequestChanged,
  onPublished,
}: PublishDialogProps) {
  const t = useT();
  const githubClient = useMCPClient({
    connectionId: githubConnectionId,
    orgId,
    orgSlug,
  });
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const { data: session } = authClient.useSession();
  const startSandbox = useSandboxStart(selfClient);

  const coAuthor = coAuthorFromSessionUser(session?.user);

  const commitToOpenPr = openPullRequest?.state === "open";
  const openPrFromCommits = dialogIntent === "open-pr" && !commitToOpenPr;
  /** Side "Publish" button — direct publish to base, single green button. */
  const isPublishOnly = dialogIntent === "publish-only";

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [isLoadingGitDiff, setIsLoadingGitDiff] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishTitle, setPublishTitle] = useState("");
  const [publishBody, setPublishBody] = useState("");
  const [publishError, setPublishError] = useState<string>();
  const [isSubmittingForReview, setIsSubmittingForReview] = useState(false);
  const [submitForReviewError, setSubmitForReviewError] = useState<string>();
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);
  const [isDiscardingAll, setIsDiscardingAll] = useState(false);
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);

  const loadStartedRef = useRef(false);
  const reprovisionAttemptedRef = useRef(false);

  const baseDiffOpts = {
    base: baseBranch,
    ...(headSha ? { headSha } : {}),
  };

  // Direct publish squash-merges base…HEAD PLUS the working tree, so show and
  // gate the union of both — a single daemon diff only returns one. For every
  // other flow a single diff is the whole story (working tree when dirty, else
  // base…head), picked by shouldUseBaseDiff.
  const loadPublishDiff = async (status: GitStatus): Promise<GitDiffResult> => {
    const baseDiff =
      (status.aheadOfBase ?? 0) > 0
        ? await fetchGitDiff(orgSlug, virtualMcpId, branch, baseDiffOpts)
        : null;
    const workingDiff = hasGitLocalWork(status)
      ? await fetchGitDiff(orgSlug, virtualMcpId, branch)
      : null;
    return combinePublishDiffs(baseDiff, workingDiff);
  };

  const loadGitState = async () => {
    const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
    const diff = isPublishOnly
      ? await loadPublishDiff(status)
      : await fetchGitDiff(
          orgSlug,
          virtualMcpId,
          branch,
          shouldUseBaseDiff(status, { openPrFromCommits, commitToOpenPr })
            ? baseDiffOpts
            : undefined,
        );
    setGitStatus(status);
    setGitDiff(diff);
    setPublishTitle(
      t("thread.publishDialog.changesFrom", {
        branch: status.current ?? branch,
      }),
    );

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
  };

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
      try {
        await loadGitState();
      } catch (error) {
        // Preview can stay live via the gateway while studio's daemon proxy
        // still holds a stale handle. Re-provision once, then retry — same
        // self-heal path as preview.tsx's notFound → SANDBOX_START flow.
        if (isSandboxUnreachable(error) && !reprovisionAttemptedRef.current) {
          reprovisionAttemptedRef.current = true;
          try {
            await startSandbox.mutateAsync({ virtualMcpId, branch });
            await loadGitState();
            return;
          } catch (retryErr) {
            setPublishError(
              retryErr instanceof Error
                ? retryErr.message
                : t("thread.publishDialog.failedLoadAfterReprovision"),
            );
            return;
          }
        }
        setPublishError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedLoad"),
        );
      } finally {
        setIsLoadingGitDiff(false);
      }
    })();
  }

  const githubHeadBranch = readGitHeadBranch(gitStatus) ?? branch;
  const publishLabel = publishToBaseLabel(baseBranch, t);

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

  // The direct Publish button is only shown in publish-only intent; only judge
  // (spend an AI call) there, and only for a smart-policy diff that has code.
  const needsJudge =
    isPublishOnly && needsSmartReviewJudgment(gitDiff, publishPolicy);
  const { verdict, loading: judging } = useSmartReviewVerdict({
    orgSlug,
    virtualMcpId,
    branch,
    status: gitStatus,
    diff: gitDiff,
    enabled: needsJudge,
  });

  const hasLocalUnpublished = openPrFromCommits
    ? hasLocalWorkToPush(gitStatus)
    : hasUnpublishedWork(gitStatus, gitDiff);
  const canSubmit =
    !isLoadingGitDiff && (hasLocalUnpublished || openPrFromCommits);
  const publishGate = needsJudge
    ? smartReviewGate(verdict, judging)
    : canPublishDirectly(gitDiff, publishPolicy);
  const canPublish = canSubmit && publishGate.allowed;
  // The gate's `reason` carries the server/AI-generated (English) explanation;
  // we don't render it directly so the tooltip stays in the user's language.
  const publishDisabledReason =
    !canSubmit || publishGate.allowed
      ? null
      : publishGate.pending
        ? t("thread.publishDialog.reviewingChanges")
        : t("thread.publishDialog.publishNeedsReview");

  /** There is committed or uncommitted local work that can be pushed + PR'd. */
  const showSubmitForReviewButton =
    openPrFromCommits || (!commitToOpenPr && (gitStatus?.aheadOfBase ?? 0) > 0);
  const canSubmitForReview =
    !isLoadingGitDiff &&
    (showSubmitForReviewButton || hasLocalUnpublished) &&
    (diffCount > 0 || hasLocalUnpublished);

  const commitMessage = () =>
    [publishTitle.trim(), publishBody.trim()].filter(Boolean).join("\n\n");

  const handleOpenChange = (nextOpen: boolean) => {
    if (isPublishing || isSubmittingForReview) return;
    onOpenChange(nextOpen);
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishError(undefined);
    let openedPr: CreatedPullRequest | undefined;
    try {
      const prTitle =
        publishTitle.trim() ||
        t("thread.publishDialog.changesFrom", { branch: githubHeadBranch });
      const prBody = publishBody.trim() || undefined;
      const message = commitMessage() || prTitle;

      try {
        await publishGitChanges(orgSlug, virtualMcpId, branch, message);
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedPushChanges"),
          "push",
        );
      }

      try {
        await rebaseGitBranch(orgSlug, virtualMcpId, branch, baseBranch);
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedRebase"),
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
          coAuthor,
        });
      } catch (error) {
        throw new PublishFlowError(
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
          commitTitle: prTitle,
          commitMessage: prBody,
          coAuthor,
        });
      } catch (error) {
        throw new PublishFlowError(
          error instanceof Error
            ? error.message
            : t("thread.publishDialog.failedMergePullRequest"),
          "merge",
          openedPr,
        );
      }

      toast.success(t("thread.publishDialog.publishedTo", { baseBranch }));
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
      setIsPublishing(false);
    }
  };

  const handleDiscardFile = async (filepath: string) => {
    try {
      await discardGitFiles(orgSlug, virtualMcpId, branch, [filepath]);
      toast.success(t("thread.publishDialog.discardedChanges", { filepath }));
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
        error instanceof Error
          ? error.message
          : t("thread.publishDialog.failedDiscardChanges"),
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
      toast.success(t("thread.publishDialog.allChangesDiscarded"));
      setGitDiff(null);
      const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
      setGitStatus(status);
      handleOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("thread.publishDialog.failedDiscardChanges"),
      );
    } finally {
      setIsDiscardingAll(false);
    }
  };

  const handleSubmitForReview = async () => {
    setIsSubmittingForReview(true);
    setSubmitForReviewError(undefined);
    try {
      const prTitle =
        publishTitle.trim() ||
        t("thread.publishDialog.changesFrom", { branch: githubHeadBranch });
      const prBody = publishBody.trim() || undefined;
      const message = commitMessage() || prTitle;

      // GitHub requires head on the remote; push even when commits are already
      // local-only (unpushed can read 0 until origin/<branch> exists).
      await publishGitChanges(orgSlug, virtualMcpId, branch, message);

      const pr = await openPullRequestForBranch(githubClient, {
        owner,
        repo,
        branch: githubHeadBranch,
        title: prTitle,
        body: prBody,
        base: baseBranch,
        coAuthor,
      });

      toast.success(
        t("thread.publishDialog.submittedForReview", { prNumber: pr.number }),
        {
          action: {
            label: t("thread.publishDialog.viewOnGithub"),
            onClick: () =>
              window.open(pr.htmlUrl, "_blank", "noopener,noreferrer"),
          },
        },
      );
      handleOpenChange(false);
      await onPullRequestChanged?.();
    } catch (error) {
      setSubmitForReviewError(
        error instanceof Error
          ? error.message
          : t("thread.publishDialog.failedSubmitForReview"),
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
              {openPrFromCommits
                ? t("thread.publishDialog.submitForReview")
                : publishLabel}
            </p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-success" />
              {diffCount}{" "}
              {diffCount === 1
                ? t("thread.publishDialog.change")
                : t("thread.publishDialog.changes")}{" "}
              {openPrFromCommits
                ? t("thread.publishDialog.inThisPr")
                : t("thread.publishDialog.toPublish")}
            </div>
          </div>
          {discardAllConfirm ? (
            <div className="flex items-center justify-between gap-3 rounded-md bg-destructive/5 px-3 py-2">
              <span className="text-xs text-destructive">
                {t("thread.publishDialog.discardConfirmMessage")}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setDiscardAllConfirm(false)}
                >
                  {t("thread.publishDialog.cancel")}
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
                  {t("thread.publishDialog.discardAll")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <TabsList className="h-8 w-auto" variant="pill">
                <TabsTrigger value="description" className="px-3 text-xs">
                  {t("thread.publishDialog.description")}
                </TabsTrigger>
                <TabsTrigger value="changes" className="px-3 text-xs">
                  {t("thread.publishDialog.changesTab")}
                </TabsTrigger>
              </TabsList>
              {diffCount > 0 && !openPrFromCommits && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  onClick={() => setDiscardAllConfirm(true)}
                  disabled={isPublishing || isDiscardingAll}
                >
                  {t("thread.publishDialog.discardAll")}
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
              <span className="text-sm">
                {t("thread.publishDialog.loadingChanges")}
              </span>
            </div>
          ) : (
            <>
              <TabsContent value="description" className="mt-0 px-6 py-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {openPrFromCommits
                        ? t("thread.publishDialog.pullRequest")
                        : t("thread.publishDialog.commitMessage")}
                    </p>
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
                      {isGeneratingSuggestion
                        ? t("thread.publishDialog.generating")
                        : t("thread.publishDialog.regenerate")}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="publish-title"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("thread.publishDialog.title")}
                    </label>
                    <Input
                      id="publish-title"
                      value={publishTitle}
                      onChange={(e) => setPublishTitle(e.target.value)}
                      placeholder={
                        isGeneratingSuggestion
                          ? t("thread.publishDialog.generating")
                          : t("thread.publishDialog.commitTitlePlaceholder")
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
                      {t("thread.publishDialog.descriptionLabel")}
                    </label>
                    <Textarea
                      id="publish-body"
                      value={publishBody}
                      onChange={(e) => setPublishBody(e.target.value)}
                      placeholder={
                        isGeneratingSuggestion
                          ? t("thread.publishDialog.generating")
                          : t("thread.publishDialog.descriptionPlaceholder")
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
                    {t("thread.publishDialog.branchLabel")}{" "}
                    <span className="font-mono">{branch}</span>
                    {" → "}
                    <span className="font-mono">{baseBranch}</span>
                    {" · "}
                    <span className="text-foreground/80">
                      {isPublishOnly
                        ? t("thread.publishDialog.squashMergesInto", {
                            publishLabel,
                            baseBranch,
                          })
                        : t("thread.publishDialog.opensPullRequestInto", {
                            baseBranch,
                          })}
                    </span>
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
              {t("thread.publishDialog.visitPreview")}
            </span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="shrink-0 border-t px-6 py-3">
          {isPublishOnly ? (
            <>
              <PublishButton
                label={publishLabel}
                canPublish={canPublish}
                disabledReason={publishDisabledReason}
                isPublishing={isPublishing}
                onPublish={handlePublish}
              />
              {publishError && (
                <p className="mt-2 text-xs text-destructive">{publishError}</p>
              )}
            </>
          ) : (
            <>
              <Button
                type="button"
                className="w-full"
                onClick={handleSubmitForReview}
                disabled={!canSubmitForReview || isSubmittingForReview}
              >
                {isSubmittingForReview ? (
                  <Loading01 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch01 className="h-4 w-4" />
                )}
                {t("thread.publishDialog.submitForReviewButton")}
              </Button>
              {submitForReviewError && (
                <p className="mt-2 text-xs text-destructive">
                  {submitForReviewError}
                </p>
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
  onPublish,
}: {
  label: string;
  canPublish: boolean;
  disabledReason: string | null;
  isPublishing: boolean;
  onPublish: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="success"
      className="w-full"
      onClick={onPublish}
      disabled={!canPublish || isPublishing}
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
          <span className="flex w-full">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
