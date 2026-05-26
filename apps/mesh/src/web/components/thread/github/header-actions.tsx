import {
  parseBranchMap,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Separator } from "@deco/ui/components/separator.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { authClient } from "@/web/lib/auth-client.ts";
import { getActiveGithubRepo } from "@/web/lib/github-repo.ts";
import { generateBranchName } from "@/shared/branch-name";
import { useChatStream } from "../../chat/chat-context.tsx";
import { useChatTask } from "../../chat/index";
import { useSandboxGitStatus } from "@/web/components/sandbox/hooks/use-sandbox-git-status.ts";
import { squashMergePullRequest } from "./github-pr-api.ts";
import { MergeSplitButton } from "./merge-split-button.tsx";
import { PublishDialog } from "./publish-dialog.tsx";
import { selectHeaderButton, type HeaderButton } from "./panel-state.ts";
import * as tpl from "./message-templates.ts";
import { saveChangesDebug } from "./save-changes-debug.ts";
import { resolveSandboxBranchFromMap } from "./resolve-sandbox-branch.ts";
import {
  mergeBranchMetaWithGitStatus,
  readGitHeadBranch,
} from "./sandbox-git-api.ts";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events.ts";
import { useChecks, usePrByBranch } from "./use-pr-data.ts";
import { usePrReviews } from "./use-pr-reviews.ts";

interface Props {
  virtualMcpId: string;
}

const LOADING_BRANCH_BUTTON: HeaderButton = {
  label: "Loading branch…",
  disabled: true,
  loading: true,
  variant: "outline",
  tooltip: "Waiting for sandbox branch",
};

/**
 * HeaderActions renders a single next-action button for the current branch +
 * PR state. Save changes opens the publish dialog; open-PR and squash-merge
 * call GitHub MCP tools directly. Other actions still send chat prompts.
 *
 * Gated on an active GitHub repo. Once wired, the button always renders —
 * disabled status pills (Loading…, Up to date, Published, …) cover cases
 * where there is no actionable next step.
 */
export function HeaderActions({ virtualMcpId }: Props) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const vm = useVirtualMCP(virtualMcpId);
  const { currentBranch: branch, setCurrentTaskBranch } = useChatTask();
  const chat = useChatStream();
  const [publishOpen, setPublishOpen] = useState(false);
  const [githubActionPending, setGithubActionPending] = useState(false);
  const debugKeyRef = useRef("");

  const githubRepo = getActiveGithubRepo(vm);
  const userId = session?.user?.id;

  const githubClient = useMCPClient({
    connectionId: githubRepo?.connectionId ?? "",
    orgId: org.id,
    orgSlug: org.slug,
  });

  const {
    lifecycle,
    branch: branchMeta,
    phase: claimPhase,
    notFound: sandboxGone,
  } = useSandboxEvents();

  const sandboxBranch = branchMeta.kind === "ready" ? branchMeta.branch : null;
  const sandboxMapBranch = resolveSandboxBranchFromMap(
    vm?.metadata?.sandboxMap,
    userId,
    branch ?? sandboxBranch,
  );
  const sandboxRouteBranch =
    branch ?? sandboxBranch ?? sandboxMapBranch ?? undefined;

  const gitStatusQuery = useSandboxGitStatus({
    orgSlug: org.slug,
    virtualMcpId,
    branch: sandboxRouteBranch ?? null,
    enabled: !!githubRepo && !!sandboxRouteBranch && !sandboxGone,
  });

  const githubHeadBranch =
    readGitHeadBranch(gitStatusQuery.data) ?? sandboxRouteBranch ?? null;

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
    prNumber: pr && pr.state === "open" ? pr.number : null,
  });

  const reviewsQuery = usePrReviews({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    prNumber: pr && pr.state === "open" ? pr.number : null,
  });

  const effectiveBranchMeta = mergeBranchMetaWithGitStatus(
    branchMeta,
    gitStatusQuery.data,
  );

  if (!githubRepo) return null;

  const branchMap =
    userId && githubHeadBranch
      ? parseBranchMap(vm?.metadata?.sandboxMap?.[userId]?.[githubHeadBranch])
      : {};
  const branchMapEntries = Object.values(branchMap);
  const vmEntry =
    branchMapEntries.find((e) => e.sandboxProviderKind !== "user-desktop") ??
    branchMapEntries[0];
  const previewUrl = vmEntry?.previewUrl ?? null;

  const button = githubHeadBranch
    ? selectHeaderButton({
        lifecycle,
        branch: effectiveBranchMeta,
        claimPhase,
        pr,
        checks: checksQuery.data ?? [],
        reviews: reviewsQuery.data ?? null,
        loading: prQuery.isPending,
      })
    : LOADING_BRANCH_BUTTON;

  const debugKey = JSON.stringify({
    label: button.label,
    branchKind: effectiveBranchMeta.kind,
    workingTreeDirty:
      effectiveBranchMeta.kind === "ready"
        ? effectiveBranchMeta.workingTreeDirty
        : null,
    gitModifiedCount: gitStatusQuery.data?.modified.length ?? null,
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
      gitStatus: gitStatusQuery.data ?? null,
      lifecyclePhase: lifecycle.phase,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
    });
  }

  const send = (text: string) =>
    chat.sendMessage({ parts: [{ type: "text", text }] });

  const isStreaming = chat.isStreaming;

  const baseBranch =
    effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.base : "main";

  const refreshPrState = async () => {
    await Promise.all([
      prQuery.refetch(),
      gitStatusQuery.refetch(),
      checksQuery.refetch(),
      reviewsQuery.refetch(),
    ]);
  };

  const switchToFreshBranch = async () => {
    const nextBranch = generateBranchName();
    await setCurrentTaskBranch(nextBranch);
  };

  const handleSquashMerge = async (pullNumber: number) => {
    if (!githubRepo?.connectionId || githubActionPending) return;
    setGithubActionPending(true);
    try {
      await squashMergePullRequest(githubClient, {
        owner: githubRepo.owner,
        repo: githubRepo.name,
        pullNumber,
      });
      toast.success(`Published PR #${pullNumber}`);
      await refreshPrState();
      await switchToFreshBranch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to merge pull request",
      );
    } finally {
      setGithubActionPending(false);
    }
  };

  const onActivate = (action: HeaderButton["action"]) => {
    if (!action || !githubHeadBranch) return;
    switch (action) {
      case "commit-and-push":
      case "create-pr":
        setPublishOpen(true);
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
      case "merge-split":
        return;
    }
  };

  const actionBusy = githubActionPending || isStreaming;

  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-2 data-[orientation=vertical]:h-5"
      />
      <HeaderButtonRenderer
        button={button}
        actionBusy={actionBusy}
        githubActionPending={githubActionPending}
        onActivate={onActivate}
        prNumber={pr?.number}
        onSquashMerge={handleSquashMerge}
        onReview={
          pr
            ? () => {
                if (isStreaming) return;
                void send(tpl.reviewPr({ prNumber: pr.number }));
              }
            : undefined
        }
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
          onPullRequestChanged={refreshPrState}
          onPublished={switchToFreshBranch}
        />
      )}
    </>
  );
}

function HeaderButtonRenderer(props: {
  button: HeaderButton;
  actionBusy: boolean;
  githubActionPending: boolean;
  onActivate: (action: HeaderButton["action"]) => void;
  prNumber?: number;
  onSquashMerge: (pullNumber: number) => void | Promise<void>;
  onReview?: () => void;
}) {
  const { button, actionBusy, githubActionPending } = props;
  const chatBlocksAction =
    actionBusy &&
    button.action !== "create-pr" &&
    button.action !== "commit-and-push" &&
    button.action !== "merge-split";
  const disabled =
    Boolean(button.disabled) ||
    chatBlocksAction ||
    (githubActionPending && button.action === "merge-split");
  const loading =
    Boolean(button.loading) ||
    (githubActionPending && button.action === "merge-split");
  const tooltipLabel = chatBlocksAction
    ? "Chat is running"
    : (button.tooltip ?? null);

  if (button.action === "merge-split" && props.prNumber != null) {
    return (
      <WithTooltip label={tooltipLabel}>
        <MergeSplitButton
          prNumber={props.prNumber}
          disabled={disabled}
          loading={loading}
          onPublish={() => props.onSquashMerge(props.prNumber!)}
          onReview={props.onReview}
        />
      </WithTooltip>
    );
  }

  return (
    <WithTooltip label={tooltipLabel}>
      <Button
        size="sm"
        variant={button.variant}
        disabled={disabled}
        onClick={() => {
          if (button.action) props.onActivate(button.action);
        }}
      >
        {loading ? <Spinner size="xs" variant="default" /> : null}
        {button.label}
      </Button>
    </WithTooltip>
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
