/** Wraps `/$org/settings/...`, mirroring the org shell's arrangement. On
 *  desktop `SettingsSidebar` carries the org switcher, the way back and the
 *  collapse trigger, so no bar spans the top; the toolbar header renders on
 *  MOBILE only, where it holds the hamburger for `MobileSidebarSheet`. Routed
 *  children land in a `SidebarInset` content card. */

import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PageContentClassNameProvider } from "@/components/page";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { SettingsSidebarMobile } from "@/components/sidebar/settings-sidebar";
import { Toolbar } from "@/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";
import { useProjectContext } from "@/sdk";
import { useStatusSounds } from "../hooks/use-status-sounds";

/** 3.125rem → 34px collapsed-rail buttons, matching the expanded toolbar's.
 *  Keep in sync with org-shell-layout. */
/** The content card holding the routed children. */
function SettingsInset() {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();

  /** Org-wide SSE sound notifications. */
  useStatusSounds(org.slug);

  const content = (
    <MainPanelBoundary>
      <div className="flex flex-1 items-center overflow-hidden rounded-[inherit]">
        <PageContentClassNameProvider value="p-0">
          <div className="flex-1 min-w-0 overflow-hidden h-full">
            <Outlet />
          </div>
        </PageContentClassNameProvider>
      </div>
    </MainPanelBoundary>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col flex-1 bg-background min-h-0 overflow-hidden">
        {content}
      </div>
    );
  }

  // `p-1.5` = the workspace panel card's gutter, where the sidebar header starts.
  return (
    <div className="flex-1 min-h-0 p-1.5">
      <div
        className={cn(
          "flex flex-col h-full min-h-0 bg-background overflow-hidden",
          "card-shadow",
          "rounded-[0.75rem]",
        )}
      >
        {content}
      </div>
    </div>
  );
}

export default function SettingsLayout() {
  const isMobile = useIsMobile();

  return (
    <Toolbar.Provider>
      <div className="flex flex-col h-full min-h-0">
        {/* Mobile only: on desktop the sidebar `OrgLayout` already mounted
            carries the picker and the collapse trigger, so a full-width bar
            above it would be an empty strip. Mobile has no sidebar on screen,
            so it still needs somewhere to put the hamburger. */}
        {isMobile && (
          <Toolbar.Header>
            <Toolbar.LeftColumn>
              <SidebarTriggerButton />
            </Toolbar.LeftColumn>
            <Toolbar.CenterSlot />
            <Toolbar.RightColumn>
              <span />
            </Toolbar.RightColumn>
          </Toolbar.Header>
        )}
        <SettingsInset />
      </div>
      {isMobile && (
        <MobileSidebarSheet
          renderSidebar={({ onClose }) => (
            <SettingsSidebarMobile onClose={onClose} />
          )}
        />
      )}
    </Toolbar.Provider>
  );
}
