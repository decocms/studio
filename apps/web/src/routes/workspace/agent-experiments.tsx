import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { ExperimentsTab } from "@/layouts/main-panel-tabs/experiments-tab";
import { ExperimentsTabSkeleton } from "@/layouts/main-panel-tabs/experiments-block-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useLastFoundV8, useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { experimentsRouteView } from "@/layouts/main-panel-tabs/experiments-tab-choice";

function AgentExperimentsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  const siteMajor = useMainSchemaV8(virtualMcpId);
  const lastFoundV8 = useLastFoundV8(virtualMcpId);
  switch (
    experimentsRouteView({
      orgEnabled: views.experiments,
      siteMajor,
      lastFoundV8,
    })
  ) {
    case "tab":
      return <ExperimentsTab virtualMcpId={virtualMcpId} />;
    // A site last found v8 gets the tab whatever the rollout: wait for it.
    case "loading":
      return <ExperimentsTabSkeleton />;
    case "settings":
      return <SettingsTab virtualMcpId={virtualMcpId} />;
  }
}

export default function AgentExperimentsRoute() {
  return (
    <ChatLayout.Content actions={<SiteDraftActions blocksOnly />}>
      <AgentExperimentsContent />
    </ChatLayout.Content>
  );
}
