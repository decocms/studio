/** The organization's home.
 *
 *  New Layout splits it in two on one route: `?view=agents` is the switch,
 *  Today is the daily brief and Agents is every run and every schedule. They
 *  are one route because this tree cannot take another child — see the `view`
 *  param's own note in `router.tsx` — and one param is a far smaller price than
 *  `prev: any` at every search callsite in the app.
 *
 *  Classic keeps the roster-and-feed page it always had. */

import { useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { AgentsPage } from "@/components/org-agents/agents-page";
import { TodayPage } from "@/components/org-home/today-page";
import { OrgAgentsTab } from "@/layouts/main-panel-tabs/org-agents-tab";
import { useProjectFirstNav } from "@/hooks/use-preferences";

function HomeBody() {
  const projectFirstNav = useProjectFirstNav();
  const search = useSearch({ strict: false }) as { view?: "agents" };

  if (!projectFirstNav) return <OrgAgentsTab />;
  return search.view === "agents" ? <AgentsPage /> : <TodayPage />;
}

export default function HomeRoute() {
  return (
    <ChatLayout.Content>
      <HomeBody />
    </ChatLayout.Content>
  );
}
