import type { ReactNode } from "react";
import { PanelVisibilityToggle } from "./toggle-buttons";
import { useWorkspace } from "./workspace-context";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { SidebarTriggerButton } from "@/layouts/shell-controls";

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

export function WorkspaceMainTrailing() {
  const workspace = useWorkspace();
  return (
    <div className="hidden shrink-0 md:block">
      <PanelVisibilityToggle
        panel="main"
        open={workspace.mainOpen}
        onToggle={workspace.toggleMain}
      />
    </div>
  );
}
