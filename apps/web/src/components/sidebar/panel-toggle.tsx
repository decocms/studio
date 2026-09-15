import { PanelVisibilityToggle } from "@/layouts/agent-shell-layout/toggle-buttons";
import { useWorkspacePanels } from "@/layouts/workspace-panels-context";

export function SidebarPanelToggle() {
  const { sidePanelOpen, toggleSidePanel } = useWorkspacePanels();
  return (
    <PanelVisibilityToggle
      panel="chat"
      open={sidePanelOpen}
      onToggle={toggleSidePanel}
    />
  );
}
