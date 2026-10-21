import { ChatLayout } from "@/components/chat-layout";
import { ExperimentsTab } from "@/layouts/main-panel-tabs/experiments-tab";
import { ExperimentsTabSkeleton } from "@/layouts/main-panel-tabs/experiments-tab-v8";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { experimentsTabVisible } from "@/layouts/main-panel-tabs/experiments-tab-choice";

function AgentExperimentsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  const siteMajor = useMainSchemaV8(virtualMcpId);
  if (experimentsTabVisible(views.experiments, siteMajor)) {
    return <ExperimentsTab virtualMcpId={virtualMcpId} />;
  }
  // Whether a site is v8 (and so gets the tab) isn't known yet: wait.
  if (siteMajor === "loading") return <ExperimentsTabSkeleton />;
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

export default function AgentExperimentsRoute() {
  return (
    <ChatLayout.Content>
      <AgentExperimentsContent />
    </ChatLayout.Content>
  );
}
