import { Suspense, lazy } from "react";
import { AlertTriangle, Loading01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t";
import { useQuery } from "@tanstack/react-query";
import {
  countLocalWork,
  fetchGitStatus,
  hasPublishableLocalWork,
  sandboxGitStatusQueryKey,
} from "@/components/thread/github/sandbox-git-api";
import { useProjectContext } from "@/sdk";
import { useChatTask } from "@/components/chat/context";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { hasEditableDecoContent } from "@/components/sections-editor/page-list";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
} from "@/components/sandbox/preview/last-preview-page";
import { useBlocksPreviewWorkspace } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { GlobalLoaderEditor } from "@/components/sandbox/blocks/global-loader-editor";
import {
  resolveBlocksTabState,
  toBlocksQueryState,
} from "@/layouts/main-panel-tabs/blocks-tab-state";
import {
  BlocksEmptyState,
  BlocksErrorState,
} from "@/layouts/main-panel-tabs/blocks-tab-states";
import { MainPanelLoading } from "@/layouts/main-panel-tabs/main-panel-loading";

/**
 * The dev environment holds work this view cannot see.
 *
 * Editing content in CMS mode commits to the branch head. When the draft also
 * has a pod carrying an uncommitted working tree, that head is NOT what the
 * agent is editing — the two diverge, and the agent's next commit resolves the
 * conflict one way or the other. The switch permits this on purpose; the least
 * it owes the user is to say so while it is true.
 *
 * Deliberately silent otherwise. A clean pod, or no pod, means the head is
 * authoritative and there is nothing to report — and an advisory that shows on
 * every CMS project is one nobody reads by the second week.
 */
function StaleHeadNotice({ count }: { count: number }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2">
      <AlertTriangle
        size={14}
        className="mt-0.5 shrink-0 text-warning"
        aria-hidden
      />
      <span className="text-xs leading-relaxed text-foreground">
        {t("sandbox.blocksPanel.staleHeadNotice", { count: String(count) })}
      </span>
    </div>
  );
}

const SectionsEditor = lazy(() =>
  import("@/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

export function BlocksPanel({
  virtualMcpId,
  externalSelection = null,
}: {
  virtualMcpId: string;
  /**
   * Section selected via click-through from the preview iframe. `seq` is the
   * iframe's per-click counter — it makes two clicks on the same section two
   * distinct selections, so re-clicking one reopens its form.
   */
  externalSelection?: { index: number; seq: number } | null;
}) {
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();
  const sandboxEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  /**
   * The pod's REAL working tree. `/git/status` stays daemon-backed whenever a
   * sandbox exists — the API gates on the substrate, not on `?mode=` — so this
   * sees the agent's uncommitted work even while the UI is in CMS mode. That
   * asymmetry is what makes the advisory possible at all.
   */
  const podBranch = lifecycle.vmEntry ? (currentBranch ?? "") : "";
  const podStatus = useQuery({
    queryKey: sandboxGitStatusQueryKey(org.slug, virtualMcpId, podBranch),
    queryFn: () => fetchGitStatus(org.slug, virtualMcpId, podBranch),
    enabled: !!podBranch,
    staleTime: 15_000,
  });
  const staleCount = hasPublishableLocalWork(podStatus.data)
    ? countLocalWork(podStatus.data)
    : 0;
  const workspace = useBlocksPreviewWorkspace();
  const devServerReady = sandboxEvents.lifecycle.phase === "running";
  const previewUrl = lifecycle.previewUrl;
  // Not gated on the dev server: when it's down (crashed/paused) we read the
  // committed `.deco/*.gen.json` snapshot so the Blocks form editor still opens
  // (block edits persist to the FS). The live routes take over once it's up.
  const fetchParams = currentBranch
    ? {
        orgSlug: org.slug,
        virtualMcpId,
        branch: currentBranch,
        previewUrl,
      }
    : null;
  const decofile = useDecofile(fetchParams, { fetchEnabled: devServerReady });
  const meta = useLiveMeta(fetchParams, { fetchEnabled: devServerReady });
  const state = resolveBlocksTabState({
    lifecyclePhase: sandboxEvents.lifecycle.phase,
    decofile: toBlocksQueryState(decofile),
    meta: toBlocksQueryState(meta),
    hasEditableContent: hasEditableDecoContent(decofile.data, meta.data),
    cmsModeActive: lifecycle.cmsModeActive,
  });

  if (state.kind === "loading") return <MainPanelLoading />;
  if (state.kind === "empty") return <BlocksEmptyState />;
  if (state.kind === "error") {
    const retry = () => {
      if (state.source === "sandbox") {
        lifecycle.retry();
        return;
      }
      void Promise.all([decofile.refetch(), meta.refetch()]);
    };
    return <BlocksErrorState source={state.source} onRetry={retry} />;
  }

  // Blocks edits whatever page its sibling Preview canvas is on. The shared
  // workspace target is published by Preview; when Preview hasn't run yet,
  // fall back to the last visited page persisted for this project + branch.
  const target = workspace.state.target;

  // Loaders have their own editor (form + Run), not the sections editor.
  if (target?.kind === "loader" && decofile.data && meta.data) {
    return (
      <div
        data-testid="blocks-panel"
        className="h-full min-h-0 overflow-hidden"
      >
        <GlobalLoaderEditor
          orgSlug={org.slug}
          virtualMcpId={virtualMcpId}
          branch={currentBranch ?? ""}
          previewUrl={previewUrl ?? null}
          meta={meta.data}
          decofile={decofile.data}
          blockKey={target.key}
        />
      </div>
    );
  }

  const saved =
    target || !currentBranch
      ? null
      : readLastPreviewPage(
          lastPreviewPageKey(org.slug, virtualMcpId, currentBranch),
        );

  let currentPath = "/";
  let activePageBlockKey: string | null = null;
  let activeGlobalBlockKey: string | null = null;
  if (target?.kind === "page") {
    currentPath = target.path;
    activePageBlockKey = target.key;
  } else if (target?.kind === "section") {
    activeGlobalBlockKey = target.key;
  } else if (saved) {
    currentPath = saved.path;
    activePageBlockKey = saved.pageKey;
  }

  const editorKey = activePageBlockKey
    ? `page:${activePageBlockKey}`
    : activeGlobalBlockKey
      ? `section:${activeGlobalBlockKey}`
      : `path:${currentPath}`;

  return (
    <div
      data-testid="blocks-panel"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {staleCount > 0 && <StaleHeadNotice count={staleCount} />}
      <Suspense
        fallback={
          <div className="h-full flex items-center justify-center">
            <Loading01
              size={20}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <SectionsEditor
          key={editorKey}
          orgSlug={org.slug}
          virtualMcpId={virtualMcpId}
          branch={currentBranch ?? ""}
          previewReady
          previewUrl={previewUrl ?? undefined}
          currentPath={currentPath}
          activePageBlockKey={activePageBlockKey}
          activeGlobalBlockKey={activeGlobalBlockKey}
          externalSelection={activeGlobalBlockKey ? null : externalSelection}
          initialEditSeo={
            !!activePageBlockKey &&
            workspace.state.editSeoPageKey === activePageBlockKey
          }
          onExitSeo={workspace.consumeEditSeo}
          onVariantPreviewOverride={workspace.setVariantOverride}
        />
      </Suspense>
    </div>
  );
}
