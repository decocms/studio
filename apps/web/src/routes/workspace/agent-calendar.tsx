import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { CalendarTab } from "@/layouts/main-panel-tabs/calendar-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useBlocksV8Project } from "@/hooks/use-blocks-v8-project";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentCalendarContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  // Only a Blocks v8 project has a campaigns calendar; any other gets Settings.
  if (useBlocksV8Project(virtualMcpId)) {
    return <CalendarTab virtualMcpId={virtualMcpId} />;
  }
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

/** The campaigns calendar, with the site editor's draft bar on top. */
export default function AgentCalendarRoute() {
  return (
    <ChatLayout.Content actions={<SiteDraftActions blocksOnly />}>
      <AgentCalendarContent />
    </ChatLayout.Content>
  );
}
