import { useMCPClient, useProjectContext, useVirtualMCP } from "@/sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client.ts";
import { coAuthorFromSessionUser } from "@/lib/co-author-identity.ts";
import { resolveGithubAttachment } from "@/lib/github-repo.ts";
import { useChatStream } from "../../chat/chat-context.tsx";
import { useChatTask } from "../../chat/index";
import { squashMergePullRequest } from "./github-pr-api.ts";
import { MergeSplitButton } from "./merge-split-button.tsx";
import { PublishDialog } from "./publish-dialog.tsx";
import {
  isPrStateActivelyLoading,
  selectHeaderButton,
  type HeaderButton,
} from "./panel-state.ts";
import * as tpl from "./message-templates.ts";
import { saveChangesDebug } from "./save-changes-debug.ts";
import { resolveSandboxBranchFromMap } from "./resolve-sandbox-branch.ts";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events.ts";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context.tsx";
import { usePublishGate } from "@/components/sandbox/hooks/use-publish-gate.ts";
import { useChecks, usePrByBranch } from "./use-pr-data.ts";
import { usePrReviews } from "./use-pr-reviews.ts";
import { normalizePublishPolicy, type PublishGate } from "./sandbox-git-api.ts";
import { useT, type TFunction } from "@/i18n/use-t";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";

interface Props {
  virtualMcpId: string;
}

// Sentinel for the branch-not-yet-selected state; labels are filled in
// at render time using the translated versions from the component.
function makeBranchLoadingButton(t: TFunction): HeaderButton {
  return {
    label: t("thread.headerActions.loadingBranch"),
    disabled: true,
    loading: true,
    variant: "outline",
    tooltip: t("thread.headerActions.waitingForSandboxBranchTooltip"),
  };
}

/**
 * HeaderActions renders the next-action button for the current branch + PR
 * state, plus a persistent green "Publish" button beside it while there is
 * local work not yet merged. Submit-for-review and squash-merge call GitHub
 * MCP tools directly (via the publish dialog); other actions send chat prompts.
 *
 * Mounted for `attached` and `detached` repos (see resolveGithubAttachment).
 * When attached the button always renders — disabled status pills (Loading…,
 * Up to date, Published, …) cover cases with no actionable next step. When
 * detached it renders a reconnect pill rather than nothing.
 */
export function HeaderActions({ virtualMcpId }: Props) {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const vm = useVirtualMCP(virtualMcpId);
  const { currentBranch: branch } = useChatTask();
  const chat = useChatStream();
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishDialogIntent, setPublishDialogIntent] = useState<
    "open-pr" | "publish-only"
  >("open-pr");
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
    lifecycle,
    branch: branchMeta,
    phase: claimPhase,
  } = useSandboxEvents();

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

  // Git state comes solely from the daemon's `branch` SSE event, which is
  // emitted on connect and on every fs/.git change and backstopped by the
  // daemon's own poll fallback. It also applies the boot-dirty baseline filter
  // that a raw /git/status poll would miss.
  const effectiveBranchMeta = branchMeta;

  // Gate the side "Publish" button up-front: fetch the direct-publish diff and
  // disable the button (with a tooltip) when it contains code, instead of
  // opening a dialog whose Publish button is already dead. Only fetch when
  // there's local work not yet merged (i.e. a side Publish button could show).
  const publishGateBase =
    effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.base : "main";
  const publishGateEnabled =
    effectiveBranchMeta.kind === "ready" &&
    Boolean(sandboxRouteBranch) &&
    (effectiveBranchMeta.workingTreeDirty ||
      effectiveBranchMeta.unpushed > 0 ||
      effectiveBranchMeta.aheadOfBase > 0);
  const publishGateSignature =
    effectiveBranchMeta.kind === "ready"
      ? `${effectiveBranchMeta.headSha}:${effectiveBranchMeta.workingTreeDirty}:${effectiveBranchMeta.unpushed}:${effectiveBranchMeta.aheadOfBase}`
      : "unknown";
  const publishPolicy = normalizePublishPolicy(vm?.metadata?.publishPolicy);
  const { gate: publishGate } = usePublishGate({
    orgSlug: org.slug,
    virtualMcpId,
    branch: sandboxRouteBranch ?? "",
    base: publishGateBase,
    headSha:
      effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.headSha : null,
    signature: publishGateSignature,
    policy: publishPolicy,
    enabled: publishGateEnabled,
  });

  // Detached: repo linked via a GitHub connection that's no longer aggregated.
  // Render a reconnect pill instead of nothing so the user has a recovery path
  // (a stale/mid-mutation aggregation must never leave the header blank).
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

  // Live preview URL comes from the sandbox lifecycle, not the raw vMCP
  // sandboxMap. Hosted (agent-sandbox / shared-staging) sandboxes persist their
  // previewUrl in `agentSandboxSessions`, which the lifecycle overlays onto the
  // branch map; the raw `vm.metadata.sandboxMap` never carries it, so reading it
  // here left "Visit preview" permanently disabled for those sandboxes.
  const { previewUrl } = useSandboxLifecycle();

  const button = githubHeadBranch
    ? selectHeaderButton({
        lifecycle,
        branch: effectiveBranchMeta,
        claimPhase,
        pr,
        checks: checksQuery.data ?? [],
        reviews: reviewsQuery.data ?? null,
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

  const send = (text: string) =>
    chat.sendMessage({ parts: [{ type: "text", text }] });

  const isStreaming = chat.isStreaming;

  const baseBranch =
    effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.base : "main";

  const refreshPrState = async () => {
    await Promise.all([
      prQuery.refetch(),
      checksQuery.refetch(),
      reviewsQuery.refetch(),
    ]);
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

  const onActivate = (action: HeaderButton["action"]) => {
    if (!action || !githubHeadBranch) return;
    switch (action) {
      case "create-pr":
        setPublishDialogIntent("open-pr");
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

  const onPublishSide = () => {
    setPublishDialogIntent("publish-only");
    setPublishOpen(true);
  };

  // The persistent green "Publish" button (publish-only dialog, single green
  // button gated by isDecoOnlyDiff so code changes still require review) is
  // owned by the panel-state descriptor — set on states with local work not
  // yet merged, and never on merge-split (where the primary button IS publish).
  const showPublishSide = button.showPublishSide ?? false;

  const actionBusy = githubActionPending || isStreaming;

  return (
    <>
      <HeaderButtonRenderer
        t={t}
        button={button}
        actionBusy={actionBusy}
        githubActionPending={githubActionPending}
        onActivate={onActivate}
        showPublishSide={showPublishSide}
        onPublishSide={onPublishSide}
        publishGate={publishGate}
        prNumber={pr?.number}
        prBase={pr?.base}
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
          publishPolicy={publishPolicy}
          dialogIntent={publishDialogIntent}
          headSha={
            effectiveBranchMeta.kind === "ready"
              ? effectiveBranchMeta.headSha
              : null
          }
          openPullRequest={
            publishDialogIntent === "publish-only"
              ? null
              : pr?.state === "open"
                ? pr
                : null
          }
          onPullRequestChanged={refreshPrState}
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
  onActivate: (action: HeaderButton["action"]) => void;
  showPublishSide: boolean;
  onPublishSide: () => void;
  publishGate: PublishGate;
  prNumber?: number;
  prBase?: string;
  onSquashMerge: (pullNumber: number) => void | Promise<void>;
  onReview?: () => void;
}) {
  const { t, button, actionBusy, githubActionPending } = props;
  const chatBlocksAction =
    actionBusy &&
    button.action !== "create-pr" &&
    button.action !== "merge-split";
  const disabled =
    Boolean(button.disabled) ||
    chatBlocksAction ||
    (githubActionPending && button.action === "merge-split");
  const loading =
    Boolean(button.loading) ||
    (githubActionPending && button.action === "merge-split");
  const tooltipLabel = chatBlocksAction
    ? t("thread.headerActions.chatIsRunning")
    : (button.tooltip ?? null);

  if (
    button.action === "merge-split" &&
    props.prNumber != null &&
    props.prBase != null
  ) {
    return (
      <WithTooltip label={tooltipLabel}>
        <MergeSplitButton
          baseBranch={props.prBase}
          disabled={disabled}
          loading={loading}
          onPublish={() => props.onSquashMerge(props.prNumber!)}
          onReview={props.onReview}
        />
      </WithTooltip>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <WithTooltip label={tooltipLabel}>
        <Button
          size="sm"
          variant={button.variant}
          disabled={disabled}
          // Only anchor the tour's "submit for review" step when the button is
          // actually in that state. In neutral states (e.g. "Up to date", which
          // is disabled and has no action) the step would point at an unrelated
          // button; leaving the anchor off lets the tour skip the step.
          data-tour={
            button.action === "create-pr" ? TOUR_ANCHORS.submit : undefined
          }
          onClick={() => {
            if (button.action) props.onActivate(button.action);
          }}
        >
          {loading ? <Spinner size="xs" variant="default" /> : null}
          {button.label}
        </Button>
      </WithTooltip>
      {props.showPublishSide ? (
        <WithTooltip
          label={
            props.publishGate.pending
              ? t("thread.headerActions.reviewingChanges")
              : props.publishGate.allowed
                ? t("thread.headerActions.publishDirectlySkipReview")
                : (props.publishGate.reason ??
                  t("thread.headerActions.publishNeedsReview"))
          }
        >
          <Button
            size="sm"
            variant="success"
            data-tour={TOUR_ANCHORS.publish}
            disabled={props.githubActionPending || !props.publishGate.allowed}
            onClick={props.onPublishSide}
          >
            {props.publishGate.pending ? (
              <Spinner size="xs" variant="default" />
            ) : null}
            {t("thread.headerActions.publish")}
          </Button>
        </WithTooltip>
      ) : null}
    </div>
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
