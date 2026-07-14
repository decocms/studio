import { useProjectContext } from "@decocms/mesh-sdk";
import { useChatTask } from "@/web/components/chat/context";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import { hasEditableDecoContent } from "@/web/components/sections-editor/page-list";
import { resolveBlocksTabState } from "./blocks-tab-state";
import { MainPanelLoading } from "./main-panel-loading";
import { PreviewTab } from "./preview-tab";
import { BlocksEmptyState, BlocksErrorState } from "./blocks-tab-states";

export function BlocksTab({ virtualMcpId }: { virtualMcpId: string }) {
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();
  const sandboxEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  const devServerReady = sandboxEvents.lifecycle.phase === "running";
  const fetchParams =
    currentBranch && devServerReady
      ? {
          orgSlug: org.slug,
          virtualMcpId,
          branch: currentBranch,
          previewUrl: lifecycle.previewUrl,
        }
      : null;
  const decofile = useDecofile(fetchParams, { fetchEnabled: devServerReady });
  const meta = useLiveMeta(fetchParams, { fetchEnabled: devServerReady });
  const state = resolveBlocksTabState({
    lifecyclePhase: sandboxEvents.lifecycle.phase,
    decofile: {
      status: decofile.status,
      hasData: decofile.data !== undefined,
    },
    meta: { status: meta.status, hasData: meta.data !== undefined },
    hasEditableContent: hasEditableDecoContent(decofile.data, meta.data),
  });

  if (state.kind === "loading") return <MainPanelLoading />;
  if (state.kind === "content") {
    return <PreviewTab virtualMcpId={virtualMcpId} initialViewMode="cms" />;
  }
  if (state.kind === "empty") return <BlocksEmptyState />;

  const retry = () => {
    if (state.source === "sandbox") {
      lifecycle.retry();
      return;
    }
    void Promise.all([decofile.refetch(), meta.refetch()]);
  };
  return <BlocksErrorState source={state.source} onRetry={retry} />;
}
