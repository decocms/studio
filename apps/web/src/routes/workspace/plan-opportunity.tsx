import { useParams } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon-page";
import { OpportunityDetailPage } from "@/components/plan/opportunities/opportunity-detail";
import { parseOpportunityId } from "@/components/plan/opportunities/opportunity-view";
import { useOrgFlag } from "@/hooks/use-organization-settings";

function OpportunityContent() {
  const params = useParams({ strict: false });
  const opportunityId = parseOpportunityId(params.opportunityId);
  return (
    <OpportunityDetailPage key={opportunityId} opportunityId={opportunityId} />
  );
}

export default function PlanOpportunityRoute() {
  const enabled = useOrgFlag("plan_page_enabled");
  return (
    <ChatLayout.Content>
      {enabled ? <OpportunityContent /> : <ComingSoonPage kind="plan" />}
    </ChatLayout.Content>
  );
}
