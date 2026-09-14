import { AutomationsListTab } from "@/layouts/main-panel-tabs/automations-list-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <AutomationsListTab virtualMcpId={virtualMcpId} />;
}
