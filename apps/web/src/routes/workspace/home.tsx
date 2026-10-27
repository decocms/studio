/** The organization's home: Today's daily brief in New Layout, the
 *  roster-and-feed page Classic always had. */

import { ChatLayout } from "@/components/chat-layout";
import { TodayPage } from "@/components/org-home/today-page";
import { OrgAgentsTab } from "@/layouts/main-panel-tabs/org-agents-tab";
import { useProjectFirstNav } from "@/hooks/use-preferences";

function HomeBody() {
  return useProjectFirstNav() ? <TodayPage /> : <OrgAgentsTab />;
}

export default function HomeRoute() {
  return (
    <ChatLayout.Content>
      <HomeBody />
    </ChatLayout.Content>
  );
}
