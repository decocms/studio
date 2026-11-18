import { ChatLayout } from "@/components/chat-layout";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon-page";
import { PlanPage } from "@/components/plan/plan-page";
import { useOrgFlag } from "@/hooks/use-organization-settings";

export default function PlanRoute() {
  const enabled = useOrgFlag("plan_page_enabled");
  return (
    <ChatLayout.Content>
      {enabled ? <PlanPage /> : <ComingSoonPage kind="plan" />}
    </ChatLayout.Content>
  );
}
