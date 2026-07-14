import { useProjectContext, useVirtualMCP } from "@decocms/mesh-sdk";
import { AlertCircle } from "@untitledui/icons";
import { useChatTask } from "@/web/components/chat/context";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import { hasEditableDecoContent } from "@/web/components/sections-editor/page-list";
import { PreviewContent } from "@/web/components/sandbox/preview/preview";
import type { PreviewSurface } from "@/web/components/sandbox/preview/preview-surface";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { resolveBlocksTabState } from "./blocks-tab-state";
import { MainPanelLoading } from "./main-panel-loading";
import { BlocksEmptyState, BlocksErrorState } from "./blocks-tab-states";

/**
 * Preview + Blocks are the same surface with a different `surface` prop, so
 * they share ONE rendered `PreviewContent`. Switching between the two tabs only
 * flips that prop instead of swapping component subtrees — the preview iframe
 * keeps its state and never reloads.
 *
 * For this to hold, callers must (1) render this same component for both tabs
 * (same element type + position in `TabBody`) and (2) keep the wrapping
 * `ErrorBoundary` key stable across them. Otherwise React remounts and the
 * iframe reloads again.
 */
export function PreviewBlocksTab({
  surface,
  virtualMcpId,
}: {
  surface: PreviewSurface;
  virtualMcpId: string;
}) {
  const entity = useVirtualMCP(virtualMcpId);
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

  if (surface === "preview") {
    if (!agentHasClonableSource(entity?.metadata)) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground p-6">
          <AlertCircle size={24} className="text-muted-foreground/60" />
          <div>No source to preview.</div>
          <div className="text-xs text-muted-foreground/80">
            Connect a GitHub repository from the Connections tab to enable
            Preview.
          </div>
        </div>
      );
    }
    return <PreviewContent surface="preview" />;
  }

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
  if (state.kind === "content") return <PreviewContent surface="blocks" />;
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
