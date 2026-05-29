import { ContentBrowser } from "@/web/components/sandbox/content/content-browser";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AlertCircle } from "@untitledui/icons";

export function ContentTab({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  const hasClonableSource = agentHasClonableSource(entity?.metadata);

  if (!hasClonableSource) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground p-6">
        <AlertCircle size={24} className="text-muted-foreground/60" />
        <div>No content to edit.</div>
        <div className="text-xs text-muted-foreground/80">
          Connect a GitHub repository from the Settings tab to enable Content.
        </div>
      </div>
    );
  }

  return <ContentBrowser />;
}
