import { useState, type ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { useChatTask } from "@/components/chat/chat-context";
import { EmptyState } from "@/components/empty-state";
import { GitHubIcon } from "@/components/icons/github-icon";
import { RepositoryImportPicker } from "@/components/repository-import-picker";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useT } from "@/i18n/use-t.ts";
import { useVirtualMCP } from "@/sdk";

/**
 * Blog records live in the decofile, so without a checked-out source there is
 * nothing to read or write. A thread-scoped repo bound by `load_repo` lives on
 * the thread rather than the agent entity — mirror `ContentTab` so Blog and
 * the Site Editor agree on what is available.
 */
export function BlogSourceGate({
  virtualMcpId,
  children,
}: {
  virtualMcpId: string;
  children: ReactNode;
}) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const entity = useVirtualMCP(virtualMcpId);
  const { activeTask } = useChatTask();
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);

  if (hasClonableSource) return children;

  return (
    <>
      <EmptyState
        className="h-full"
        image={
          <div className="flex size-14 items-center justify-center rounded-full bg-muted">
            <GitHubIcon className="size-7 text-foreground" />
          </div>
        }
        title={t("mainPanelTabs.contentTab.noContentToEdit")}
        description={t("mainPanelTabs.contentTab.connectGithubDescription")}
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
