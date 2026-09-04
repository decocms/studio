import { Suspense, lazy, type ReactNode } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useProjectContext } from "@/sdk";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
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
import { PanelLoading } from "@/layouts/main-panel-boundary";

const SectionsEditor = lazy(() =>
  import("@/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

export function BlocksPanel({
  virtualMcpId,
  externalSelection = null,
  onViewJsonFile,
}: {
  virtualMcpId: string;
  /**
   * Section selected via click-through from the preview iframe. `seq` is the
   * iframe's per-click counter — it makes two clicks on the same section two
   * distinct selections, so re-clicking one reopens its form.
   */
  externalSelection?: { index: number; seq: number } | null;
  /**
   * Open the page's raw JSON in a side panel (Preview owns the slot). When
   * omitted the editor falls back to its local modal.
   */
  onViewJsonFile?: () => void;
}) {
  const { org } = useProjectContext();
  const { currentBranch, taskId } = useChatTask();
  const sandboxEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
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
        threadId: taskId ?? null,
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
    fastPreviewActive: useSessionRuntime(virtualMcpId).runtime === "cms",
  });

  const panel = (children: ReactNode) => (
    <div data-testid="blocks-panel" className="h-full min-h-0 overflow-hidden">
      {children}
    </div>
  );

  if (state.kind === "loading") return panel(<PanelLoading />);
  if (state.kind === "empty") return panel(<BlocksEmptyState />);
  if (state.kind === "error") {
    const retry = () => {
      if (state.source === "sandbox") {
        lifecycle.retry();
        return;
      }
      void Promise.all([decofile.refetch(), meta.refetch()]);
    };
    return panel(<BlocksErrorState source={state.source} onRetry={retry} />);
  }

  const editorPanel = (children: ReactNode) =>
    panel(<div className="h-full min-h-0">{children}</div>);

  // Blocks edits whatever page its sibling Preview canvas is on. The shared
  // workspace target is published by Preview; when Preview hasn't run yet,
  // fall back to the last visited page persisted for this project + branch.
  const target = workspace.state.target;

  // Loaders have their own editor (form + Run), not the sections editor.
  if (target?.kind === "loader" && decofile.data && meta.data) {
    return editorPanel(
      <GlobalLoaderEditor
        orgSlug={org.slug}
        virtualMcpId={virtualMcpId}
        branch={currentBranch ?? ""}
        previewUrl={previewUrl ?? null}
        meta={meta.data}
        decofile={decofile.data}
        blockKey={target.key}
      />,
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

  return editorPanel(
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
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
        onViewJsonFile={onViewJsonFile}
      />
    </Suspense>,
  );
}
