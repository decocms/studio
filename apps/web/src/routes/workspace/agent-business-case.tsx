import { useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon-page";
import { BusinessCaseTab } from "@/components/plan/business-case/business-case-tab";
import { PlanPage } from "@/components/plan/plan-page";
import { useOrgFlag } from "@/hooks/use-organization-settings";

function BusinessCaseContent() {
  const search = useSearch({ strict: false });
  const path =
    "path" in search && typeof search.path === "string"
      ? search.path
      : undefined;
  return path ? <BusinessCaseTab key={path} path={path} /> : <PlanPage />;
}

export default function AgentBusinessCaseRoute() {
  const enabled = useOrgFlag("plan_page_enabled");
  return (
    <ChatLayout.Content>
      {enabled ? <BusinessCaseContent /> : <ComingSoonPage kind="plan" />}
    </ChatLayout.Content>
  );
}
