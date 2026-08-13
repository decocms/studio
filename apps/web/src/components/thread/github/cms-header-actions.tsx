/**
 * Header actions for **Fast Preview** (CMS) mode — the sandbox-less,
 * content-only editing surface.
 *
 * `HeaderActions` is the vibecoding renderer: it mounts the sandbox event
 * stream, the sandbox lifecycle and the publish gate, and five of its states
 * dispatch chat prompts. Fast Preview has none of those — no daemon, no coding
 * agent, no chat — so it renders this component instead, driven by the
 * {@link selectCmsHeaderButton} state machine and a single split button.
 *
 * The branch happens at the mount point (`VirtualMcpHeaderInfo`) rather than
 * inside `HeaderActions`, so in Fast Preview the sandbox hooks never mount.
 */

import type { BranchMeta } from "@decocms/sandbox/shared";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
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
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { GitPullRequest, RefreshCw01, Rocket02 } from "@untitledui/icons";
import { GitHubIcon } from "@/components/icons/github-icon.tsx";
import { useT } from "@/i18n/use-t";
import { authClient } from "@/lib/auth-client.ts";
import { resolveGithubAttachment } from "@/lib/github-repo.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { decofileWriteMutationKey } from "../../sections-editor/decofile-api.ts";
import { useChatTask } from "../../chat/index";
import { selectCmsHeaderButton, type CmsAction } from "./cms-panel-state.ts";
import { isPrStateActivelyLoading } from "./panel-state.ts";
import { PublishDialog, type PublishDialogIntent } from "./publish-dialog.tsx";
import {
  fetchGitStatus,
  hasPublishableLocalWork,
  normalizePublishPolicy,
  readGitHeadBranch,
  rebaseGitBranch,
  sandboxGitStatusQueryKey,
} from "./sandbox-git-api.ts";
import { useChecks, usePrByBranch } from "./use-pr-data.ts";
import { usePrReviews } from "./use-pr-reviews.ts";

interface Props {
  virtualMcpId: string;
}

/** `open-pr` covers both the GitHub links; `key` separates them from each other. */
function actionIcon(action: CmsAction, key?: string) {
  if (action === "open-pr" || key === "resolve-on-github") {
    return <GitHubIcon size={16} />;
  }
  if (action === "publish") return <Rocket02 className="size-4" />;
  if (action === "get-latest") return <RefreshCw01 className="size-4" />;
  return <GitPullRequest className="size-4" />;
}

export function CmsHeaderActions({ virtualMcpId }: Props) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const vm = useVirtualMCP(virtualMcpId);
  const { currentBranch: branch, setCurrentTaskBranch } = useChatTask();
  const [publishOpen, setPublishOpen] = useState(false);
  const [dialogIntent, setDialogIntent] =
    useState<PublishDialogIntent>("publish-only");

  const attachment = resolveGithubAttachment(vm);
  const githubRepo =
    attachment.status === "attached" || attachment.status === "public-clone"
      ? attachment.repo
      : null;
  const { previewServerUrl } = resolveFastPreview(vm?.metadata);

  /** Poll-free on purpose: every call forwards to GitHub; save hooks invalidate this key. */
  const statusQuery = useQuery({
    queryKey: sandboxGitStatusQueryKey(org.slug, virtualMcpId, branch ?? ""),
    queryFn: () => fetchGitStatus(org.slug, virtualMcpId, branch ?? ""),
    enabled: !!branch,
    staleTime: 15_000,
  });
  const status = statusQuery.data ?? null;
  const branchMeta: BranchMeta = status
    ? {
        kind: "ready",
        branch: readGitHeadBranch(status) ?? branch ?? "",
        base: status.base ?? "main",
        workingTreeDirty: hasPublishableLocalWork(status),
        unpushed: status.unpushed ?? 0,
        aheadOfBase: status.aheadOfBase ?? 0,
        behindBase: status.behindBase ?? 0,
        headSha: status.headSha ?? "",
      }
    : { kind: "unknown" };

  const githubHeadBranch =
    (branchMeta.kind === "ready" ? branchMeta.branch : null) ?? branch ?? null;
  const baseBranch = branchMeta.kind === "ready" ? branchMeta.base : "main";

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

  const refreshPrState = async () => {
    await Promise.all([
      prQuery.refetch(),
      checksQuery.refetch(),
      reviewsQuery.refetch(),
    ]);
  };

  /**
   * A squash-merge leaves the published commits on the branch, so the editor
   * has to move to a fresh one or the next edit would re-publish work that is
   * already live. Modelled as a mutation so `isPending` — not a hand-rolled
   * flag — is what tells the state machine a publish is still settling.
   */
  const publishCompletion = useMutation({
    mutationFn: async () => {
      await setCurrentTaskBranch(
        generateBranchName(branchUserLabel(session?.user)),
      );
    },
    /** The dialog is already closed by now, so a toast is the only surface. */
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const getLatest = useMutation({
    mutationFn: async (target: { branch: string; base: string }) => {
      await rebaseGitBranch(
        org.slug,
        virtualMcpId,
        target.branch,
        target.base,
        { onConflict: "branch-wins" },
      );
      return target;
    },
    /** Invalidates drift AND the editor's content: the merge moved the head. */
    onSuccess: async (target) => {
      toast.success(
        t("thread.headerActions.syncedWithBase", { base: target.base }),
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sandboxGitStatusQueryKey(
            org.slug,
            virtualMcpId,
            branch ?? target.branch,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: KEYS.decofile(
            `${org.slug}/${virtualMcpId}/${target.branch}`,
          ),
        }),
      ]);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  /** Same in-flight signal the preview's autosave indicator reads. */
  const saving =
    useIsMutating({
      mutationKey: decofileWriteMutationKey(
        org.slug,
        virtualMcpId,
        branch ?? "",
      ),
    }) > 0;

  /**
   * Detached: repo linked via a GitHub connection that's no longer aggregated.
   * Render a reconnect pill instead of nothing so the user has a recovery path.
   */
  if (attachment.status === "detached") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" variant="outline" disabled>
                {t("thread.headerActions.reconnectGithub")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t("thread.headerActions.githubConnectionRemoved")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (!githubRepo) return null;

  /**
   * Only the tail of the publish — the branch switch that follows the merge.
   *
   * While the dialog is open it owns the progress UI for its own
   * push → rebase → open PR → squash-merge sequence, and it sits over this
   * button. Treating "dialog open" as publishing would label the button
   * "Publishing…" the whole time the editor is still *reading* the diff and
   * deciding, which is precisely what "Review & Publish" promises they get to
   * do first.
   */
  const publishing = publishCompletion.isPending;

  const button = selectCmsHeaderButton({
    branch: branchMeta,
    pr,
    checks: checksQuery.data ?? [],
    reviews: reviewsQuery.data ?? null,
    publishing,
    saving,
    loading: isPrStateActivelyLoading(prQuery),
    t,
  });

  const openDialog = (intent: PublishDialogIntent) => {
    setDialogIntent(intent);
    setPublishOpen(true);
  };

  const dispatch = (action: CmsAction) => {
    switch (action) {
      case "publish":
        openDialog("publish-only");
        return;
      case "request-approval":
        openDialog("open-pr");
        return;
      case "get-latest":
        if (!githubHeadBranch || getLatest.isPending) return;
        getLatest.mutate({ branch: githubHeadBranch, base: baseBranch });
        return;
      case "open-pr":
        if (pr?.htmlUrl) {
          window.open(pr.htmlUrl, "_blank", "noopener,noreferrer");
        }
        return;
    }
  };

  const items: SplitButtonMenuItem[] = button.menu.map((item) => ({
    key: item.key,
    label: item.label,
    icon: actionIcon(item.action, item.key),
    ...(item.tooltip ? { tooltip: item.tooltip } : {}),
    onSelect: () => dispatch(item.action),
  }));

  const action = button.action;

  return (
    <>
      <SplitButton
        size="sm"
        label={button.label}
        variant={button.variant}
        disabled={Boolean(button.disabled) || !action}
        loading={Boolean(button.loading)}
        pulse={Boolean(button.pulse)}
        {...(action === "publish" && !button.loading
          ? { icon: <Rocket02 className="size-4" /> }
          : {})}
        {...(button.tooltip ? { tooltip: button.tooltip } : {})}
        items={items}
        menuAriaLabel={t("thread.cmsActions.moreActionsAriaLabel")}
        onClick={action ? () => dispatch(action) : undefined}
      />
      {branch ? (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          orgSlug={org.slug}
          orgId={org.id}
          virtualMcpId={virtualMcpId}
          branch={branch}
          baseBranch={baseBranch}
          githubConnectionId={githubRepo.connectionId ?? ""}
          owner={githubRepo.owner}
          repo={githubRepo.name}
          previewUrl={previewServerUrl}
          publishPolicy={normalizePublishPolicy(vm?.metadata?.publishPolicy)}
          dialogIntent={dialogIntent}
          headSha={branchMeta.kind === "ready" ? branchMeta.headSha : null}
          openPullRequest={pr?.state === "open" ? pr : null}
          onPullRequestChanged={refreshPrState}
          onPublished={() => publishCompletion.mutateAsync()}
        />
      ) : null}
    </>
  );
}
