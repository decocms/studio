import { ContentBrowser } from "@/components/sandbox/content/content-browser";
import { useChatTask } from "@/components/chat/chat-context";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useVirtualMCP } from "@/sdk";
import { AlertCircle } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

export function ContentTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const { activeTask } = useChatTask();
  // A thread-scoped repo (bound by `load_repo`) is editable even when the agent
  // itself has no clonable source (e.g. the ephemeral Decopilot agent) — mirror
  // PreviewTab so Content and Preview agree on what's available.
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);

  if (!hasClonableSource) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground p-6">
        <AlertCircle size={24} className="text-muted-foreground/60" />
        <div>{t("mainPanelTabs.contentTab.noContentToEdit")}</div>
        <div className="text-xs text-muted-foreground/80">
          {t("mainPanelTabs.contentTab.connectGithubDescription")}
        </div>
      </div>
    );
  }

  return <ContentBrowser />;
}
