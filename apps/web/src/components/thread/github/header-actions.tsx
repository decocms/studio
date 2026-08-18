import { useMCPClient, useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { decofileWriteMutationKey } from "@/components/sections-editor/decofile-api";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useState, useRef, type ComponentType } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client.ts";
import { KEYS } from "@/lib/query-keys";
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
import {
  fetchGitStatus,
  normalizePublishPolicy,
  readGitHeadBranch,
  rebaseGitBranch,
  sandboxGitStatusQueryKey,
  type PublishGate,
} from "./sandbox-git-api.ts";
import type {
  BranchMeta,
  LifecycleState,
} from "@/components/sandbox/hooks/sandbox-events-context";
import { useT, type TFunction } from "@/i18n/use-t";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";
import {
  AlertTriangle,
  CheckCircle,
  GitPullRequest,
  MessageCircle01,
  RefreshCw01,
  Upload01,
} from "@untitledui/icons";

interface Props {
  virtualMcpId: string;
}

/**
 * Leading icon per actionable header state. Below 768px of PANEL HEADER these
 * buttons collapse to icon-only (the label moves to the tooltip); above it the
 * text label shows as before. Status pills (no `action`) have no icon and keep
 * their text. `merge-split` is omitted — it renders via MergeSplitButton.
 *
 * The query is `@container/panel-header` (declared by PanelHeader), not the
 * viewport: this cluster sits in one panel, so screen width says nothing about
 * the room it has — with chat open a 1400px screen can leave it under 700px.
 * 768px is the same cut the view tabs and Chat use, so the whole strip
 * collapses together instead of in two stages. These components render only
 * inside a PanelHeader; outside one the query finds no container and the label
 * simply stays, which is the safe direction.
 */
const ACTION_ICON: Partial<
  Record<
    NonNullable<HeaderButton["action"]>,
    ComponentType<{ className?: string }>
  >
> = {
  "create-pr": GitPullRequest,
  reopen: RefreshCw01,
  rebase: RefreshCw01,
  "fix-checks": AlertTriangle,
  "mark-ready": CheckCircle,
  "resolve-comments": MessageCircle01,
};

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
 *
 * Sandbox-less Fast Preview projects use the SAME component and dialogs: the
 * `/git/*` routes answer from the GitHub API server-side, and the only client
 * difference is where branch metadata comes from — the daemon's `branch` SSE
 * event has no daemon to emit it, so it's polled from `/git/status` instead
 * (see `effectiveBranchMeta` below).
 */
export function HeaderActions({ virtualMcpId }: Props) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
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
  const [publishDialogIntent, setPublishDialogIntent] = useState<
    "open-pr" | "publish-only"
  >("open-pr");
  const [githubActionPending, setGithubActionPending] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
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

  // Sandbox-less: no daemon → no `branch` SSE event. Fetch the (GitHub-backed)
  // status route into the same BranchMeta shape — but never on an interval:
  // every route below forwards to the GitHub API, and a timer here burns rate
  // limit for data that only changes when WE commit. The only in-app mutation
  // is the decofile PATCH, whose save hooks invalidate this key; external
  // pushes are picked up on window focus. (In sandbox mode the equivalent
  // traffic hits the local daemon, where polling is free.)
  const fpStatusQuery = useQuery({
    queryKey: sandboxGitStatusQueryKey(org.slug, virtualMcpId, branch ?? ""),
    queryFn: () => fetchGitStatus(org.slug, virtualMcpId, branch ?? ""),
    enabled: fastPreviewActive && !!branch,
    staleTime: 15_000,
  });
  const fpStatus = fpStatusQuery.data ?? null;
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
  // The lifecycle gates the header copy through clone/checkout; sandbox-less
  // has no boot pipeline, so it reads as permanently running (the port /
  // htmlSupport fields are dev-server facts nothing on this surface reads).
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
  // Fast Preview: never pre-fetch the gate. Its queryFn re-polls status and
  // assembles the full-content base…head diff every 10s, which in sandbox-less
  // mode is all GitHub API traffic (the 429 path). Disabled, the gate resolves
  // `{allowed: true, ready: false}`, so the side Publish click falls through to
  // the dialog — which loads the diff once, on open, and gates there.
  const publishGateEnabled =
    !fastPreviewActive &&
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

  // An in-flight block autosave (decofile PATCH, or the sandbox file write)
  // means the branch state the publish surfaces would act on is mid-change:
  // disable them and render the same animated bar the preview shows, so
  // "wait for the save" is legible right where the user is about to click.
  const decofileSaving =
    useIsMutating({
      mutationKey: decofileWriteMutationKey(
        org.slug,
        virtualMcpId,
        branch ?? sandboxRouteBranch ?? "",
      ),
    }) > 0;

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
  // sandboxMap: the lifecycle overlays the thread's own sandbox record onto the
  // branch map, and the raw `vm.metadata.sandboxMap` does not always carry the
  // previewUrl — reading it here left "Visit preview" permanently disabled for
  // hosted sandboxes.
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

  const send = (text: string) => {
    // Header actions can fire while the chat side panel is closed (e.g. from the
    // GitHub tab), so surface the chat so the user sees the message we just sent.
    openSidePanel("chat");
    return chat.sendMessage({ parts: [{ type: "text", text }] });
  };

  const isStreaming = chat.isStreaming;

  const baseBranch =
    effectiveBranchMeta.kind === "ready" ? effectiveBranchMeta.base : "main";

  // Sandbox mode: org-level opt-in (metadata.syncButtonEnabled) so a business
  // user doesn't have to know they need to commit before they can rebase —
  // one deterministic chat prompt does the git work in the sandbox.
  // Fast Preview: no sandbox and no chat to delegate to, so Sync shows
  // whenever the branch is behind base and calls the GitHub-backed rebase
  // route directly, auto-resolving conflicts in the branch's favour (the
  // person syncing is the person editing; a conflict dialog is worse for a
  // non-technical user than a branch-favoured merge).
  const showSync =
    (vm?.metadata?.syncButtonEnabled === true ||
      (fastPreviewActive &&
        effectiveBranchMeta.kind === "ready" &&
        effectiveBranchMeta.behindBase > 0)) &&
    Boolean(githubRepo) &&
    Boolean(githubHeadBranch);
  const handleSync = () => {
    if (isStreaming || !githubHeadBranch) return;
    if (!fastPreviewActive) {
      void send(tpl.syncBranch({ branch: githubHeadBranch, base: baseBranch }));
      return;
    }
    if (syncPending) return;
    setSyncPending(true);
    rebaseGitBranch(org.slug, virtualMcpId, githubHeadBranch, baseBranch, {
      onConflict: "branch-wins",
    })
      .then(() => {
        toast.success(
          t("thread.headerActions.syncedWithBase", { base: baseBranch }),
        );
        // The merge moved the head: refresh drift AND the editor's content
        // (the refetch re-stashes the draft version, which reloads the frame).
        return Promise.all([
          queryClient.invalidateQueries({
            queryKey: sandboxGitStatusQueryKey(
              org.slug,
              virtualMcpId,
              branch ?? githubHeadBranch,
            ),
          }),
          queryClient.invalidateQueries({
            queryKey: KEYS.decofile(
              `${org.slug}/${virtualMcpId}/${githubHeadBranch}`,
            ),
          }),
        ]);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSyncPending(false));
  };

  const refreshPrState = async () => {
    await Promise.all([
      prQuery.refetch(),
      checksQuery.refetch(),
      reviewsQuery.refetch(),
    ]);
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

  const actionBusy = githubActionPending || isStreaming || syncPending;

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
        showSync={showSync}
        onSync={handleSync}
        publishGate={publishGate}
        savePending={decofileSaving}
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
          openPullRequest={pr?.state === "open" ? pr : null}
          onPullRequestChanged={refreshPrState}
          onPublished={switchToFreshBranch}
          {...(fastPreviewActive
            ? { rebaseOnConflict: "branch-wins" as const }
            : {})}
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
  showSync: boolean;
  onSync: () => void;
  publishGate: PublishGate;
  savePending: boolean;
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
      <div className="flex items-center gap-2">
        {props.showSync ? (
          <SyncButton t={t} busy={actionBusy} onClick={props.onSync} />
        ) : null}
        <WithTooltip label={tooltipLabel}>
          <MergeSplitButton
            baseBranch={props.prBase}
            disabled={disabled}
            loading={loading}
            onPublish={() => props.onSquashMerge(props.prNumber!)}
            onReview={props.onReview}
          />
        </WithTooltip>
      </div>
    );
  }

  const ActionIcon = button.action ? ACTION_ICON[button.action] : undefined;
  // Actionable / loading states collapse to icon (or spinner) only below 768px
  // of panel header; the label stays reachable via the tooltip. Plain status
  // pills (no action, not loading) keep their text at every size.
  const collapseLabel = Boolean(ActionIcon) || loading;
  // "Submit for review" acts on the branch head, which an in-flight autosave
  // is about to move — hold it (and show the save bar) until the write lands.
  const savingBlocksSubmit = props.savePending && button.action === "create-pr";

  return (
    <div className="flex items-center gap-2">
      {props.showSync ? (
        <SyncButton t={t} busy={actionBusy} onClick={props.onSync} />
      ) : null}
      <WithTooltip
        label={
          savingBlocksSubmit ? t("thread.headerActions.saving") : tooltipLabel
        }
      >
        <Button
          size="sm"
          variant={button.variant}
          disabled={disabled || savingBlocksSubmit}
          aria-label={button.label}
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
          {loading ? (
            <Spinner size="xs" variant="default" />
          ) : ActionIcon ? (
            <ActionIcon className="size-4 shrink-0 @3xl/panel-header:hidden" />
          ) : null}
          <span className={cn(collapseLabel && "@max-3xl/panel-header:hidden")}>
            {button.label}
          </span>
        </Button>
      </WithTooltip>
      {props.showPublishSide ? (
        <WithTooltip
          label={
            props.savePending
              ? t("thread.headerActions.saving")
              : props.publishGate.pending
                ? t("thread.headerActions.reviewingChanges")
                : props.publishGate.allowed
                  ? t("thread.headerActions.publishDirectlySkipReview")
                  : (props.publishGate.reason ??
                    t("thread.headerActions.publishNeedsReview"))
          }
        >
          <Button
            size="sm"
            variant="brand"
            data-tour={TOUR_ANCHORS.publish}
            disabled={
              props.githubActionPending ||
              !props.publishGate.allowed ||
              props.savePending
            }
            onClick={props.onPublishSide}
            aria-label={t("thread.headerActions.publish")}
          >
            {props.publishGate.pending ? (
              <Spinner size="xs" variant="default" />
            ) : (
              <Upload01 className="size-4 shrink-0 @3xl/panel-header:hidden" />
            )}
            <span className="@max-3xl/panel-header:hidden">
              {t("thread.headerActions.publish")}
            </span>
          </Button>
        </WithTooltip>
      ) : null}
    </div>
  );
}

/**
 * Same visual weight as the primary "Submit for review" button (variant
 * "default") — this is a peer action, not a secondary one, so a business
 * user reads it as equally first-class.
 */
function SyncButton({
  t,
  busy,
  onClick,
}: {
  t: TFunction;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <WithTooltip label={t("thread.headerActions.syncTooltip")}>
      <Button
        size="sm"
        variant="default"
        disabled={busy}
        onClick={onClick}
        aria-label={t("thread.headerActions.sync")}
      >
        <RefreshCw01 className="size-4 shrink-0 @3xl/panel-header:hidden" />
        <span className="@max-3xl/panel-header:hidden">
          {t("thread.headerActions.sync")}
        </span>
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
