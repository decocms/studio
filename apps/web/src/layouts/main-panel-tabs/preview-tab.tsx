import { useState } from "react";
import { NewBlocksEditorProvider } from "@/hooks/use-new-blocks-editor";
import { useChatTask } from "@/components/chat/chat-context";
import { PreviewContent } from "@/components/sandbox/preview/preview";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useVirtualMCP } from "@/sdk";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import { GitHubIcon } from "@/components/icons/github-icon";
import { RepositoryImportPicker } from "@/components/repository-import-picker";
import { useT } from "@/i18n/use-t.ts";
import { resolvePreviewSource } from "./preview-source";
import { Monitor01 } from "@untitledui/icons";
import { servePreviewUrl } from "@/components/sections-editor/content-backend";
import { RichCode } from "@/components/sections-editor/deco-serve-notices";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useTaskMetadata } from "./use-task-metadata";

export function PreviewTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const { connection: serveConnection } = useDecoServeConnection(virtualMcpId);
  const { activeTask, taskId, currentBranch } = useChatTask();
  const threadMetadata = useTaskMetadata(taskId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const backend = useContentBackend(virtualMcpId, currentBranch);
  // Resolved exactly like the tab bar (see preview-source) off the same thread
  // metadata, so a visible Preview tab can never render "no source to preview"
  // — and a repo-less sandbox task run, whose tab is hidden, still renders the
  // empty state if it is deep-linked to.
  const previewSource = resolvePreviewSource({
    threadId: taskId,
    sandboxBranch: activeTask?.branch ?? currentBranch,
    agentHasRepo: agentHasClonableSource(entity?.metadata),
    threadHasRepo:
      agentHasClonableSource(threadMetadata) ||
      agentHasClonableSource(activeTask?.metadata),
  });

  // A connected `deco serve` is a source of its own (`/site-editor` has no repo).
  if (previewSource === "none" && !serveConnection) {
    return (
      <>
        <EmptyState
          className="h-full"
          image={
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <GitHubIcon className="size-7 text-foreground" />
            </div>
          }
          title={t("mainPanelTabs.previewTab.noSourceToPreview")}
          description={t("mainPanelTabs.previewTab.connectGithubDescription")}
          actions={
            <Button onClick={() => setPickerOpen(true)}>
              <GitHubIcon className="size-4" />
              {t("mainPanelTabs.previewTab.connectGithub")}
            </Button>
          }
        />
        <RepositoryImportPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          mode="agent"
        />
      </>
    );
  }

  // Localhost (a project's `deco serve`): the preview is the app it reports.
  // Until there is one, guide instead of booting a sandbox or showing the
  // hosted draft. `/site-editor` has its own gate.
  if (serveConnection && entity && !servePreviewUrl(backend)) {
    const connected = backend.kind === "protocol";
    return (
      <EmptyState
        className="h-full"
        image={
          <div className="flex size-14 items-center justify-center rounded-full bg-muted">
            <Monitor01 className="size-7 text-foreground" />
          </div>
        }
        title={t(
          connected
            ? "mainPanelTabs.previewTab.localhostNoPreview.title"
            : "mainPanelTabs.previewTab.localhostWaiting.title",
        )}
        description={
          <RichCode
            text={t(
              connected
                ? "mainPanelTabs.previewTab.localhostNoPreview.body"
                : "mainPanelTabs.previewTab.localhostWaiting.body",
            )}
          />
        }
      />
    );
  }

  return (
    <NewBlocksEditorProvider>
      <PreviewContent virtualMcpId={virtualMcpId} />
    </NewBlocksEditorProvider>
  );
}
