import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { useParams } from "@tanstack/react-router";
import { AutomationTab } from "@/layouts/main-panel-tabs/automation-tab";

function AgentAutomationContent() {
  const { automationId } = useParams({ strict: false });
  return automationId ? (
    <AutomationTab tabId={`automation:${automationId}`} />
  ) : null;
}

export default function AgentAutomationPage() {
  return (
    <WorkspacePage>
      <AgentAutomationContent />
    </WorkspacePage>
  );
}
