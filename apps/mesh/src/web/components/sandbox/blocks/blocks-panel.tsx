import { Suspense, lazy } from "react";
import { Loading01 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useChatTask } from "@/web/components/chat/context";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { hasEditableDecoContent } from "@/web/components/sections-editor/page-list";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
} from "@/web/components/sandbox/preview/last-preview-page";
import { useBlocksPreviewWorkspace } from "@/web/components/sandbox/blocks/blocks-preview-workspace-context";
import { resolveBlocksTabState } from "@/web/layouts/main-panel-tabs/blocks-tab-state";
import {
  BlocksEmptyState,
  BlocksErrorState,
} from "@/web/layouts/main-panel-tabs/blocks-tab-states";
import { MainPanelLoading } from "@/web/layouts/main-panel-tabs/main-panel-loading";

const SectionsEditor = lazy(() =>
  import("@/web/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

function errorStatus(error: unknown): number | undefined {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

export function BlocksPanel({
  virtualMcpId,
  externalSelectedIndex = null,
}: {
  virtualMcpId: string;
  /** Section index selected via click-through from the preview iframe. */
  externalSelectedIndex?: number | null;
}) {
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();
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
        previewUrl,
      }
    : null;
  const decofile = useDecofile(fetchParams, { fetchEnabled: devServerReady });
  const meta = useLiveMeta(fetchParams, { fetchEnabled: devServerReady });
  const state = resolveBlocksTabState({
    lifecyclePhase: sandboxEvents.lifecycle.phase,
    decofile: {
      status: decofile.status,
      hasData: decofile.data !== undefined,
      errorStatus: errorStatus(decofile.error),
    },
    meta: {
      status: meta.status,
      hasData: meta.data !== undefined,
      errorStatus: errorStatus(meta.error),
    },
    hasEditableContent: hasEditableDecoContent(decofile.data, meta.data),
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
    <div data-testid="blocks-panel" className="h-full min-h-0 overflow-hidden">
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
          externalSelectedIndex={
            activeGlobalBlockKey ? null : externalSelectedIndex
          }
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
