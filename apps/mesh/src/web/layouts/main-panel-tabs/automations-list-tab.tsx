import { Suspense } from "react";
import { AutomationsList } from "@/web/views/automations/automations-list";
import { MainPanelLoading } from "./main-panel-loading";

export function AutomationsListTab({ virtualMcpId }: { virtualMcpId: string }) {
  return (
    <Suspense fallback={<MainPanelLoading />}>
      <AutomationsList virtualMcpId={virtualMcpId} />
    </Suspense>
  );
}
