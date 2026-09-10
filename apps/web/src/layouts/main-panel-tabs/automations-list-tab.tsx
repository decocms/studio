import { Suspense } from "react";
import { AutomationsList } from "@/views/automations/automations-list";
import { PanelLoading } from "@/layouts/main-panel-boundary";

export function AutomationsListTab({ virtualMcpId }: { virtualMcpId: string }) {
  return (
    <Suspense fallback={<PanelLoading />}>
      <AutomationsList virtualMcpId={virtualMcpId} />
    </Suspense>
  );
}
