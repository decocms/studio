import { useState } from "react";
import { useChatTask } from "@/components/chat/chat-context";
import { PreviewContent } from "@/components/sandbox/preview/preview";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useVirtualMCP } from "@/sdk";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitHubRepoPicker } from "@/components/github-repo-picker";
import { useT } from "@/i18n/use-t.ts";
import { resolvePreviewSource } from "./preview-source";
import { useTaskMetadata } from "./use-task-metadata";

export function PreviewTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const { activeTask, taskId } = useChatTask();
  const threadMetadata = useTaskMetadata(taskId);
  const { previewUrl } = useSandboxLifecycle();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Resolved exactly like the tab bar (see preview-source) off the same thread
  // metadata, so a visible Preview tab can never render "no source to preview":
  // a thread-scoped repo previews its checkout, and a repo-less sandbox-hosted
  // run previews its sandbox dev server.
  const previewSource = resolvePreviewSource({
    harnessId: activeTask?.harness_id,
    agentHasRepo: agentHasClonableSource(entity?.metadata),
    threadHasRepo:
      agentHasClonableSource(threadMetadata) ||
      agentHasClonableSource(activeTask?.metadata),
    hasSandboxPreviewUrl: !!previewUrl,
  });

  if (previewSource === "none") {
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
        <GitHubRepoPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          mode="agent"
        />
      </>
    );
  }

  return <PreviewContent virtualMcpId={virtualMcpId} />;
}
