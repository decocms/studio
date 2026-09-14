import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}
