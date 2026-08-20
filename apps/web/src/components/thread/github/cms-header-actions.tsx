/**
 * Header actions for **Fast Preview** (CMS) mode — the sandbox-less,
 * content-only editing surface.
 *
 * `HeaderActions` is the coding-session renderer: it mounts the sandbox event
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
import { useFastPreviewDraftUrl } from "../../sections-editor/use-fast-preview-draft-url.ts";
import { fillPathTemplate } from "../../sections-editor/page-path-utils.ts";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
} from "../../sandbox/preview/last-preview-page.ts";
import { useChatTask } from "../../chat/index";
import {
  CmsPublishPopover,
  type CmsPublishMode,
} from "./cms-publish-popover.tsx";
import {
  isCmsStateSettling,
  selectCmsHeaderButton,
  type CmsAction,
} from "./cms-panel-state.ts";
import {
  hasPublishableLocalWork,
  normalizePublishPolicy,
  readGitHeadBranch,
  rebaseGitBranch,
  sandboxGitStatusQueryKey,
  sandboxGitStatusQueryOptions,
} from "./sandbox-git-api.ts";
import { useChecks, useLastPublishedPr, usePrByBranch } from "./use-pr-data.ts";
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
  if (action === "get-latest" || action === "retry-status") {
    return <RefreshCw01 className="size-4" />;
  }
  return <GitPullRequest className="size-4" />;
}

export function CmsHeaderActions({ virtualMcpId }: Props) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const vm = useVirtualMCP(virtualMcpId);
  const { currentBranch: branch, setCurrentTaskBranch } = useChatTask();
  /** One popover, two modes. `mode` outlives `open` so the closing animation
   *  doesn't flash the other mode's labels on its way out. */
  const [surface, setSurface] = useState<{
    open: boolean;
    mode: CmsPublishMode;
  }>({ open: false, mode: "publish" });
  const openSurface = (mode: CmsPublishMode) =>
    setSurface({ open: true, mode });

  const attachment = resolveGithubAttachment(vm);
  const githubRepo =
    attachment.status === "attached" || attachment.status === "public-clone"
      ? attachment.repo
      : null;
  const { previewServerUrl } = resolveFastPreview(vm?.metadata);

  const lastPage = branch
    ? readLastPreviewPage(lastPreviewPageKey(org.slug, virtualMcpId, branch))
    : null;
  const draftPath = lastPage
    ? fillPathTemplate(lastPage.path, lastPage.params)
    : "/";
  // Same draft URL the iframe's "Open in new tab" hands out (see the hook doc).
  const draftPreview = useFastPreviewDraftUrl(
    branch
      ? {
          orgSlug: org.slug,
          virtualMcpId,
          branch,
          previewServerUrl,
          path: draftPath,
        }
      : null,
  );

  /** Poll-free on purpose: every call forwards to GitHub; save hooks invalidate
   *  this key. Shared verbatim with the publish popover, which reads the
   *  changed-file manifest off the same entry — hence one options factory. */
  const statusQuery = useQuery({
    ...sandboxGitStatusQueryOptions(org.slug, virtualMcpId, branch ?? ""),
    enabled: !!branch,
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

  /** Warmed here so the popover's "last published" line is ready before the
   *  click; it is optional copy and must never gate that surface. */
  const lastPublishedQuery = useLastPublishedPr({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    base: baseBranch,
  });

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

  const settling = isCmsStateSettling({
    pr,
    prQuery,
    checksQuery,
    reviewsQuery,
  });

  /** One refetch covers checks and reviews too — they share this cache entry. */
  const refreshPrState = async () => {
    await prQuery.refetch();
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
      await rebaseGitBranch(org.slug, virtualMcpId, target.branch, target.base);
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
   * No task branch yet: the status query is disabled, so its data never
   * arrives and the state machine would sit on "Loading…" forever. There is
   * also nothing to publish without a branch — render nothing rather than a
   * spinner that resolves to nothing.
   */
  if (!branch) return null;

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
    syncing: getLatest.isPending,
    statusRetrying: statusQuery.isFetching && !!statusQuery.error,
    statusError:
      statusQuery.error instanceof Error
        ? statusQuery.error.message
        : statusQuery.error
          ? String(statusQuery.error)
          : null,
    loading: Boolean(settling),
    t,
  });

  const dispatch = (action: CmsAction) => {
    switch (action) {
      case "publish":
        openSurface("publish");
        return;
      case "request-approval":
        openSurface("review");
        return;
      case "get-latest":
        if (!githubHeadBranch || getLatest.isPending) return;
        getLatest.mutate({ branch: githubHeadBranch, base: baseBranch });
        return;
      case "retry-status":
        void statusQuery.refetch();
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

  const splitButton = (
    <SplitButton
      size="sm"
      label={button.label}
      variant={button.variant}
      disabled={Boolean(button.disabled) || !action}
      loading={Boolean(button.loading)}
      {...(action && !button.loading ? { icon: actionIcon(action) } : {})}
      {...(button.tooltip ? { tooltip: button.tooltip } : {})}
      items={items}
      menuAriaLabel={t("thread.cmsActions.moreActionsAriaLabel")}
      onClick={action ? () => dispatch(action) : undefined}
    />
  );

  return (
    <>
      {branch ? (
        <CmsPublishPopover
          open={surface.open}
          mode={surface.mode}
          onOpenChange={(open) => {
            if (!open) setSurface((current) => ({ ...current, open: false }));
          }}
          orgSlug={org.slug}
          orgId={org.id}
          virtualMcpId={virtualMcpId}
          branch={branch}
          baseBranch={baseBranch}
          githubConnectionId={githubRepo.connectionId ?? ""}
          owner={githubRepo.owner}
          repo={githubRepo.name}
          publishPolicy={normalizePublishPolicy(vm?.metadata?.publishPolicy)}
          draftPreviewUrl={draftPreview.url}
          destinationHost={draftPreview.host}
          lastPublishedPr={lastPublishedQuery.data ?? null}
          onRequestApproval={() => openSurface("review")}
          openPullRequest={pr?.state === "open" ? pr : null}
          onPullRequestChanged={refreshPrState}
          onPublished={() => publishCompletion.mutateAsync()}
        >
          {splitButton}
        </CmsPublishPopover>
      ) : (
        splitButton
      )}
    </>
  );
}
