import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Panel } from "@/components/panel";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";

export default function SettingsRoute() {
  const isMobile = useIsMobile();

  return (
    <div className={cn("flex-1 min-h-0", !isMobile && "p-1.5")}>
      <Panel data-testid="settings-panel" variant={isMobile ? "plain" : "card"}>
        <Panel.Content>
          <MainPanelBoundary>
            <Outlet />
          </MainPanelBoundary>
        </Panel.Content>
      </Panel>
    </div>
  );
}
