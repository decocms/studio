import { useState } from "react";
import { useChatTask } from "@/web/components/chat/chat-context";
import { PreviewContent } from "@/web/components/sandbox/preview/preview";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";

export function PreviewTab({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  const { activeTask } = useChatTask();
  const [pickerOpen, setPickerOpen] = useState(false);
  // A thread-scoped repo (bound by `load_repo`) is previewable even when the
  // agent itself has no clonable source (e.g. the ephemeral Decopilot agent).
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);

  if (!hasClonableSource) {
    return (
      <>
        <EmptyState
          className="h-full"
          image={
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <GitHubIcon className="size-7 text-foreground" />
            </div>
          }
          title="No source to preview"
          description="Connect a GitHub repository to build and preview your site here."
          actions={
            <Button onClick={() => setPickerOpen(true)}>
              <GitHubIcon className="size-4" />
              Connect GitHub
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
