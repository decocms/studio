import { useMCPClient, useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { decofileWriteMutationKey } from "@/components/sections-editor/decofile-api";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  SplitButton,
  type SplitButtonMenuItem,
} from "@decocms/ui/components/split-button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { resolveGithubAttachment } from "@/lib/github-repo.ts";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
import { useChatStream } from "../../chat/chat-context.tsx";
import { useChatTask } from "../../chat/index";
import { usePanelActions } from "@/layouts/shell-layout";
import { squashMergePullRequest } from "./github-pr-api.ts";
import { PublishDialog, type PublishDialogIntent } from "./publish-dialog.tsx";
import {
  isPrStateActivelyLoading,
  selectHeaderButton,
  type HeaderAction,
  type HeaderButton,
} from "./panel-state.ts";
import * as tpl from "./message-templates.ts";
import { saveChangesDebug } from "./save-changes-debug.ts";
import { resolveSandboxBranchFromMap } from "./resolve-sandbox-branch.ts";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events.ts";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context.tsx";
import { useChecks, usePrByBranch } from "./use-pr-data.ts";
import { usePrReviews } from "./use-pr-reviews.ts";
import {
  fetchGitStatus,
  hasNothingToReview,
  normalizePublishPolicy,
  readGitHeadBranch,
  sandboxGitStatusQueryKey,
  type PublishPolicy,
} from "./sandbox-git-api.ts";
import type {
  BranchMeta,
  LifecycleState,
} from "@/components/sandbox/hooks/sandbox-events-context";
import { useT, type TFunction } from "@/i18n/use-t";
import { GitHubIcon } from "@/components/icons/github-icon.tsx";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";
import {
  AlertTriangle,
  CheckCircle,
  Eye,
  GitMerge,
  GitPullRequest,
  MessageCircle01,
  RefreshCw01,
  Rocket02,
} from "@untitledui/icons";

interface Props {
  virtualMcpId: string;
}

/** Leading icon per action, for the primary half and the dropdown items. */
function actionIcon(action: HeaderAction): React.ReactNode {
  switch (action) {
    case "publish":
      return <Rocket02 className="size-4" />;
    case "create-pr":
    case "reopen":
      return <GitPullRequest className="size-4" />;
    case "rebase":
    case "sync":
      return <RefreshCw01 className="size-4" />;
    case "fix-checks":
      return <AlertTriangle className="size-4" />;
    case "mark-ready":
      return <CheckCircle className="size-4" />;
    case "resolve-comments":
      return <MessageCircle01 className="size-4" />;
    case "merge":
      return <GitMerge className="size-4" />;
    case "review":
      return <Eye className="size-4" />;
    case "open-pr-page":
      return <GitHubIcon size={16} />;
  }
}

/** Actions that resolve to a chat prompt, so they must wait for the current stream. */
const CHAT_ACTIONS = new Set<HeaderAction>([
  "reopen",
  "rebase",
  "fix-checks",
  "mark-ready",
  "resolve-comments",
  "review",
  "sync",
]);

/** Actions that act on the branch head, which an in-flight autosave is about to move. */
const HEAD_ACTIONS = new Set<HeaderAction>(["publish", "create-pr"]);

/** Sentinel for the branch-not-yet-selected state, translated at render time. */
function makeBranchLoadingButton(t: TFunction): HeaderButton {
  return {
    label: t("thread.headerActions.loadingBranch"),
    disabled: true,
    loading: true,
    variant: "outline",
    tooltip: t("thread.headerActions.waitingForSandboxBranchTooltip"),
    menu: [],
  };
}

/**
 * One split button for the current branch + PR state — the same shape AND
 * language as Fast Preview's `CmsHeaderActions`: "Review & Publish" is the
 * primary happy path (publish dialog → PR → squash-merge), with
 * "Submit for review", "Get latest" and "View on GitHub" in the dropdown.
 * The sandbox surface adds its agent states ("Fix checks", "Mark ready",
 * "Address feedback"), which dispatch chat prompts. Fast Preview swaps in
 * `CmsHeaderActions` at the mount point (`VirtualMcpHeaderInfo`), but this
 * component keeps its Fast Preview fallbacks for branch metadata since the
 * `/git/*` routes answer from the GitHub API server-side either way.
 */
export function HeaderActions({ virtualMcpId }: Props) {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const vm = useVirtualMCP(virtualMcpId);
  const {
    currentBranch: branch,
    setCurrentTaskBranch,
    activeTask,
  } = useChatTask();
  const fastPreviewActive = resolveFastPreview(
    vm?.metadata,
    activeTask?.metadata,
  ).active;
  const chat = useChatStream();
  const { openSidePanel } = usePanelActions();
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishDialogIntent, setPublishDialogIntent] =
    useState<PublishDialogIntent>("open-pr");
  const [publishPolicyOverride, setPublishPolicyOverride] =
    useState<PublishPolicy | null>(null);
  const [githubActionPending, setGithubActionPending] = useState(false);
  const debugKeyRef = useRef("");

  const attachment = resolveGithubAttachment(vm);
  const githubRepo =
    attachment.status === "attached" || attachment.status === "public-clone"
      ? attachment.repo
      : null;
  const userId = session?.user?.id;

  const githubClient = useMCPClient({
    connectionId: githubRepo?.connectionId ?? "",
    orgId: org.id,
    orgSlug: org.slug,
  });

  const {
    lifecycle: sseLifecycle,
    branch: sseBranchMeta,
    phase: claimPhase,
  } = useSandboxEvents();

  /**
   * Branch metadata for sandbox-less mode (which has no `branch` SSE), and in
   * both modes the "is there anything to review" check below.
   *
   * Fast Preview never polls: every call there forwards to the GitHub API (save
   * hooks invalidate this key, focus refetch covers external pushes). With a
   * sandbox it answers from a local `git status`, so while it reports nothing to
   * review it re-asks every few seconds — that verdict disables the publish
   * button, and the agent's first edit must re-arm it without a reload.
   */
  const statusRef = {
    orgSlug: org.slug,
    virtualMcpId,
    branch: branch ?? "",
    threadId: activeTask?.id ?? null,
  };
  const statusQuery = useQuery({
    queryKey: sandboxGitStatusQueryKey(statusRef),
    queryFn: () => fetchGitStatus(statusRef),
    enabled: !!branch,
    staleTime: 15_000,
    refetchInterval: (query) =>
      !fastPreviewActive && hasNothingToReview(query.state.data)
        ? 5_000
        : false,
  });
  const gitStatus = statusQuery.data ?? null;
  const fpStatus = fastPreviewActive ? gitStatus : null;
  const branchMeta: BranchMeta = fastPreviewActive
    ? fpStatus
      ? {
          kind: "ready",
          branch: readGitHeadBranch(fpStatus) ?? branch ?? "",
          base: fpStatus.base ?? "main",
          workingTreeDirty: false,
          unpushed: 0,
          aheadOfBase: fpStatus.aheadOfBase ?? 0,
          behindBase: fpStatus.behindBase ?? 0,
          headSha: fpStatus.headSha ?? "",
        }
      : { kind: "unknown" }
    : sseBranchMeta;
  /** Sandbox-less has no boot pipeline, so lifecycle reads as permanently running. */
  const lifecycle: LifecycleState = fastPreviewActive
    ? { phase: "running", port: 0, htmlSupport: true }
    : sseLifecycle;

  const sandboxBranch = branchMeta.kind === "ready" ? branchMeta.branch : null;
  const sandboxMapBranch = resolveSandboxBranchFromMap(
    vm?.metadata?.sandboxMap,
    userId,
    branch ?? sandboxBranch,
  );
  const sandboxRouteBranch =
    branch ?? sandboxBranch ?? sandboxMapBranch ?? undefined;

  const githubHeadBranch =
    (branchMeta.kind === "ready" ? branchMeta.branch : null) ??
    sandboxRouteBranch ??
    null;

  const prQuery = usePrByBranch({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    branch: githubHeadBranch,
  });
  const pr = prQuery.data ?? null;

  const checksQuery = useChecks({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    branch: githubHeadBranch,
  });

  const reviewsQuery = usePrReviews({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    branch: githubHeadBranch,
  });

  /** Git state comes solely from the daemon's `branch` SSE event, which applies the boot-dirty baseline filter a raw /git/status poll would miss. */
  const effectiveBranchMeta = branchMeta;

  const publishPolicy = normalizePublishPolicy(vm?.metadata?.publishPolicy);

  /** An in-flight autosave means the branch state is mid-change — hold the publish surfaces until the write lands. */
  const decofileSaving =
    useIsMutating({
      mutationKey: decofileWriteMutationKey(
        org.slug,
        virtualMcpId,
        branch ?? sandboxRouteBranch ?? "",
      ),
    }) > 0;

  /** Detached repo: render a reconnect pill, never a blank header. */
  if (attachment.status === "detached") {
    return (
      <WithTooltip label={t("thread.headerActions.githubConnectionRemoved")}>
        <Button size="sm" variant="outline" disabled>
          {t("thread.headerActions.reconnectGithub")}
        </Button>
      </WithTooltip>
    );
  }
  if (!githubRepo) return null;

  /** Preview URL must come from the sandbox lifecycle — the raw `vm.metadata.sandboxMap` does not always carry it. */
  const { previewUrl } = useSandboxLifecycle();

  const button = githubHeadBranch
    ? selectHeaderButton({
        lifecycle,
        branch: effectiveBranchMeta,
        claimPhase,
        pr,
        checks: checksQuery.data ?? [],
        reviews: reviewsQuery.data ?? null,
        noReviewableDiff: hasNothingToReview(gitStatus),
        loading: isPrStateActivelyLoading(prQuery),
        t,
      })
    : makeBranchLoadingButton(t);

  const debugKey = JSON.stringify({
    label: button.label,
    branchKind: effectiveBranchMeta.kind,
    workingTreeDirty:
      effectiveBranchMeta.kind === "ready"
        ? effectiveBranchMeta.workingTreeDirty
        : null,
    unpushed:
      effectiveBranchMeta.kind === "ready"
        ? effectiveBranchMeta.unpushed
        : null,
    aheadOfBase:
      effectiveBranchMeta.kind === "ready"
        ? effectiveBranchMeta.aheadOfBase
        : null,
    lifecycle: lifecycle.phase,
    githubHeadBranch,
    noReviewableDiff: hasNothingToReview(gitStatus),
  });
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- debug dedupe ref
  if (debugKeyRef.current !== debugKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- debug dedupe ref
    debugKeyRef.current = debugKey;
    saveChangesDebug("header button", {
      label: button.label,
      tooltip: button.tooltip,
      action: button.action,
      chatBranch: branch,
      sandboxBranch,
      sandboxMapBranch,
      sandboxRouteBranch,
      githubHeadBranch,
      branchMeta,
      effectiveBranchMeta,
      lifecyclePhase: lifecycle.phase,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
    });
  }

  const send = (text: string) => {
    // Surface the chat panel so the user sees the message we just sent.
    openSidePanel("chat");
    return chat.sendMessage({ parts: [{ type: "text", text }] });
  };

  const isStreaming = chat.isStreaming;

  const baseBranch =
    effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.base : "main";

  /** One refetch covers checks and reviews too — they share this cache entry. */
  const refreshPrState = async () => {
    await prQuery.refetch();
  };

  const switchToFreshBranch = async () => {
    const nextBranch = generateBranchName(branchUserLabel(session?.user));
    await setCurrentTaskBranch(nextBranch);
  };

  const handleSquashMerge = async (pullNumber: number) => {
    if (!githubRepo?.connectionId || githubActionPending) return;
    setGithubActionPending(true);
    try {
      const coAuthor = coAuthorFromSessionUser(session?.user);
      await squashMergePullRequest(githubClient, {
        owner: githubRepo.owner,
        repo: githubRepo.name,
        pullNumber,
        coAuthor,
      });
      toast.success(
        t("thread.headerActions.publishedPr", { prNumber: String(pullNumber) }),
      );
      await refreshPrState();
      await switchToFreshBranch();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("thread.headerActions.failedToMergePullRequest"),
      );
    } finally {
      setGithubActionPending(false);
    }
  };

  const openDialog = (
    intent: PublishDialogIntent,
    policyOverride: PublishPolicy | null,
  ) => {
    setPublishDialogIntent(intent);
    setPublishPolicyOverride(policyOverride);
    setPublishOpen(true);
  };

  const dispatch = (action: HeaderAction) => {
    if (!githubHeadBranch) return;
    switch (action) {
      case "publish":
        openDialog("publish-only", button.meta?.publishPolicyOverride ?? null);
        return;
      case "create-pr":
        openDialog("open-pr", null);
        return;
      case "merge":
        if (pr) void handleSquashMerge(pr.number);
        return;
      case "sync":
        if (isStreaming) return;
        void send(
          tpl.syncBranch({ branch: githubHeadBranch, base: baseBranch }),
        );
        return;
      case "open-pr-page":
        if (pr?.htmlUrl) {
          window.open(pr.htmlUrl, "_blank", "noopener,noreferrer");
        }
        return;
      case "review":
        if (isStreaming) return;
        if (pr) void send(tpl.reviewPr({ prNumber: pr.number }));
        return;
      case "reopen":
        if (isStreaming) return;
        if (pr) void send(tpl.reopenPr({ prNumber: pr.number }));
        return;
      case "rebase":
        if (isStreaming) return;
        void send(tpl.rebaseOnBase({ branch: githubHeadBranch }));
        return;
      case "fix-checks":
        if (isStreaming) return;
        if (pr)
          void send(
            tpl.fixChecks({
              prNumber: pr.number,
              failingChecks: button.meta?.failingChecks ?? [],
            }),
          );
        return;
      case "mark-ready":
        if (isStreaming) return;
        if (pr) void send(tpl.markReadyForReview({ prNumber: pr.number }));
        return;
      case "resolve-comments":
        if (isStreaming) return;
        if (pr) void send(tpl.resolveReviewComments({ prNumber: pr.number }));
        return;
    }
  };

  const actionBusy = githubActionPending || isStreaming;

  return (
    <>
      <HeaderButtonRenderer
        t={t}
        button={button}
        actionBusy={actionBusy}
        githubActionPending={githubActionPending}
        savePending={decofileSaving}
        onAction={dispatch}
      />
      {sandboxRouteBranch && (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          orgSlug={org.slug}
          orgId={org.id}
          virtualMcpId={virtualMcpId}
          branch={sandboxRouteBranch}
          baseBranch={baseBranch}
          githubConnectionId={githubRepo.connectionId ?? ""}
          owner={githubRepo.owner}
          repo={githubRepo.name}
          previewUrl={previewUrl}
          publishPolicy={publishPolicyOverride ?? publishPolicy}
          dialogIntent={publishDialogIntent}
          headSha={
            effectiveBranchMeta.kind === "ready"
              ? effectiveBranchMeta.headSha
              : null
          }
          openPullRequest={pr?.state === "open" ? pr : null}
          onPullRequestChanged={refreshPrState}
          onPublished={switchToFreshBranch}
        />
      )}
    </>
  );
}

function HeaderButtonRenderer(props: {
  t: TFunction;
  button: HeaderButton;
  actionBusy: boolean;
  githubActionPending: boolean;
  savePending: boolean;
  onAction: (action: HeaderAction) => void;
}) {
  const { t, button, actionBusy, githubActionPending, savePending, onAction } =
    props;
  const action = button.action;

  const chatBlocksAction =
    actionBusy && action !== undefined && CHAT_ACTIONS.has(action);
  const mergePending = githubActionPending && action === "merge";
  const savingBlocksAction =
    savePending && action !== undefined && HEAD_ACTIONS.has(action);
  const disabled =
    Boolean(button.disabled) ||
    chatBlocksAction ||
    mergePending ||
    savingBlocksAction ||
    !action;
  const loading = Boolean(button.loading) || mergePending;
  const tooltip = chatBlocksAction
    ? t("thread.headerActions.chatIsRunning")
    : savingBlocksAction
      ? t("thread.headerActions.saving")
      : button.tooltip;

  const items: SplitButtonMenuItem[] = button.menu.map((item) => {
    const itemChatBlocked = actionBusy && CHAT_ACTIONS.has(item.action);
    const itemHeadBlocked = savePending && HEAD_ACTIONS.has(item.action);
    const itemMergeBlocked = item.action === "merge" && githubActionPending;
    const itemTooltip = itemHeadBlocked
      ? t("thread.headerActions.saving")
      : itemChatBlocked
        ? t("thread.headerActions.chatIsRunning")
        : item.tooltip;
    return {
      key: item.key,
      label: item.label,
      icon: actionIcon(item.action),
      disabled: Boolean(itemChatBlocked || itemHeadBlocked || itemMergeBlocked),
      ...(itemTooltip ? { tooltip: itemTooltip } : {}),
      onSelect: () => onAction(item.action),
    };
  });

  /** Tour anchors: publish on the Review & Publish primary, submit on create-pr; otherwise off, so the tour skips the step (`skipMissingElement`). */
  const tourAnchor =
    action === "publish"
      ? TOUR_ANCHORS.publish
      : action === "create-pr"
        ? TOUR_ANCHORS.submit
        : undefined;

  return (
    <span className="inline-flex" data-tour={tourAnchor}>
      <SplitButton
        size="sm"
        label={button.label}
        variant={button.variant}
        disabled={disabled}
        loading={loading}
        {...(action && !loading ? { icon: actionIcon(action) } : {})}
        {...(tooltip ? { tooltip } : {})}
        items={items}
        menuAriaLabel={t("thread.cmsActions.moreActionsAriaLabel")}
        onClick={action ? () => onAction(action) : undefined}
      />
    </span>
  );
}

function WithTooltip({
  label,
  children,
}: {
  label: string | null;
  children: React.ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{children}</span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
