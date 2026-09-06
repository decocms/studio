import { ContentBrowser } from "@/components/sandbox/content/content-browser";
import { useChatTask } from "@/components/chat/chat-context";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useVirtualMCP } from "@/sdk";
import { useSearch } from "@tanstack/react-router";
import { useT } from "@/i18n/use-t.ts";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@decocms/ui/components/button.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitHubRepoPicker } from "@/components/github-repo-picker";
import { useState } from "react";

export function ContentTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const entity = useVirtualMCP(virtualMcpId);
  const { activeTask } = useChatTask();
  // Storefront "." deep-link (see /choose-editor): preselect the visited page.
  const search = useSearch({ strict: false }) as {
    contentPageId?: string;
    contentPath?: string;
    contentPathTemplate?: string;
  };
  // A thread-scoped repo (bound by `load_repo`) is editable even when the agent
  // itself has no clonable source (e.g. the ephemeral Decopilot agent) — mirror
  // PreviewTab so Content and Preview agree on what's available.
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
          title={t("mainPanelTabs.contentTab.noContentToEdit")}
          description={t("mainPanelTabs.contentTab.connectGithubDescription")}
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

  return (
    <ContentBrowser
      deepLinkPage={{
        pageId: search.contentPageId,
        path: search.contentPath,
        pathTemplate: search.contentPathTemplate,
      }}
    />
  );
}
