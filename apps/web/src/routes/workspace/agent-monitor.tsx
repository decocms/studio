import { CdnTab } from "@/layouts/main-panel-tabs/cdn-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { usePublicConfig } from "@/hooks/use-public-config";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  const config = usePublicConfig();
  return views.monitor &&
    (config.monitorEnabled === true || config.auth.localMode === true) ? (
    <CdnTab virtualMcpId={virtualMcpId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}
