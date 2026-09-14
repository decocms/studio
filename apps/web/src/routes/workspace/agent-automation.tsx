import { useParams } from "@tanstack/react-router";
import { AutomationTab } from "@/layouts/main-panel-tabs/automation-tab";

export default function AutomationRoute() {
  const { automationId } = useParams({ strict: false });
  return automationId ? (
    <AutomationTab tabId={`automation:${automationId}`} />
  ) : null;
}
