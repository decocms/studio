import { PreviewContent } from "@/web/components/sandbox/preview/preview";
import { agentHasConnectedGithub } from "@/web/lib/agent-capabilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AlertCircle } from "@untitledui/icons";

export function PreviewTab({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  const hasConnectedGithub = agentHasConnectedGithub(entity);

  if (!hasConnectedGithub) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground p-6">
        <AlertCircle size={24} className="text-muted-foreground/60" />
        <div>No repository connected.</div>
        <div className="text-xs text-muted-foreground/80">
          Connect a GitHub repository from the Connections tab to enable
          Preview.
        </div>
      </div>
    );
  }

  return <PreviewContent />;
}
