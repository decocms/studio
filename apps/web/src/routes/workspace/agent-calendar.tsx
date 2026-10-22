import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import {
  CalendarTab,
  CalendarTabSkeleton,
} from "@/layouts/main-panel-tabs/calendar-tab";
import { editsBlocksDraft } from "@/layouts/main-panel-tabs/experiments-tab-choice";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentCalendarContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const siteMajor = useMainSchemaV8(virtualMcpId);
  if (editsBlocksDraft(siteMajor)) {
    return <CalendarTab virtualMcpId={virtualMcpId} />;
  }
  // Whether the site is v8 (and so has a calendar) isn't known yet: wait.
  if (siteMajor === "loading") return <CalendarTabSkeleton />;
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
