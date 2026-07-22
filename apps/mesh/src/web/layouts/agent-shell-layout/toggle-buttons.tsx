import { MessageCircle01 } from "@untitledui/icons";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t";
import { LibraryToggle } from "./library-toggle";
import { TasksToggle } from "./tasks-toggle";
import type { SidePanelKind } from "@/web/hooks/use-layout-state";

export interface ToggleButtonsProps {
  sidePanel: SidePanelKind | null;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  /**
   * When true, the active side-panel toggle is disabled because closing it
   * would leave a blank content area.
   */
  disableActiveSidePanelToggle?: boolean;
}

/**
 * Top-toolbar chat toggle. Renders through the shared HeaderTabButton so it
 * stays pixel-identical to the Main panel tabs (same height, icon and
 * label metrics, active/hover styling) — the only extras are the PWA titlebar
 * drag opt-out and a taller mobile touch target. (The New task action lives in
 * the sidebar toolbar, next to the thread list.)
 */
export function ToggleButtons({
  sidePanel,
  toggleSidePanel,
  disableActiveSidePanelToggle = false,
}: ToggleButtonsProps) {
  const t = useT();
  return (
    <>
      <HeaderTabButton
        title={t("agentShellLayout.toggleButtons.chat")}
        icon={{ kind: "component", Component: MessageCircle01 }}
        active={sidePanel === "chat"}
        disabled={disableActiveSidePanelToggle && sidePanel === "chat"}
        className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        onClick={() => {
          track("agent_toolbar_toggled", {
            button: "chat",
            next_state: sidePanel === "chat" ? "closed" : "open",
          });
          toggleSidePanel("chat");
        }}
      />
      {/* Tasks and Library are agent-independent overlays. */}
      <TasksToggle />
      <LibraryToggle />
    </>
  );
}
