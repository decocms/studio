import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Panel } from "@/components/panel";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { SettingsSidebarMobile } from "@/components/sidebar/settings-sidebar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";
import { useProjectContext } from "@/sdk";
import { useStatusSounds } from "@/hooks/use-status-sounds";

/** Settings share the org sidebar and own a single content panel. */
export default function SettingsLayout() {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();
  useStatusSounds(org.slug);

  return (
    <Panel variant="plain" className="bg-sidebar">
      {isMobile && (
        <Panel.Topbar>
          <Panel.Topbar.Left>
            <SidebarTriggerButton />
          </Panel.Topbar.Left>
        </Panel.Topbar>
      )}
      <div className={cn("flex-1 min-h-0", !isMobile && "p-1.5")}>
        <Panel
          data-testid="settings-panel"
          variant={isMobile ? "plain" : "card"}
        >
          <Panel.Content>
            <MainPanelBoundary>
              <Outlet />
            </MainPanelBoundary>
          </Panel.Content>
        </Panel>
      </div>
      {isMobile && (
        <MobileSidebarSheet
          renderSidebar={({ onClose }) => (
            <SettingsSidebarMobile onClose={onClose} />
          )}
        />
      )}
    </Panel>
  );
}
