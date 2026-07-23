import { ContentBrowser } from "@/web/components/sandbox/content/content-browser";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AlertCircle } from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";

export function ContentTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const hasClonableSource = agentHasClonableSource(entity?.metadata);

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
