import type { ReactNode } from "react";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { SidebarTriggerButton } from "@/layouts/shell-controls";
import { PanelVisibilityToggle } from "./toggle-buttons";
import { useWorkspace } from "./workspace-context";

export function WorkspaceMainLeading({
  children,
  currentRouteTitle,
}: {
  children?: ReactNode;
  /** Adds route-owned pages that are not contextual tabs to the mobile switcher. */
  currentRouteTitle?: string;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1 md:hidden">
        <SidebarTriggerButton />
        <MobileMainPanelTabSelect currentRouteTitle={currentRouteTitle} />
      </div>
      {children}
    </>
  );
}

export function WorkspaceMainTrailing({ children }: { children?: ReactNode }) {
  const workspace = useWorkspace();

  return (
    <>
      {children}
      <div className="hidden md:block">
        <PanelVisibilityToggle
          panel="chat"
          open={workspace.sidePanelOpen}
          onToggle={workspace.toggleSidePanel}
        />
      </div>
    </>
  );
}
