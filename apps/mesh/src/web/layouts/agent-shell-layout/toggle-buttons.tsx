import { MessageCircle01, TextInput } from "@untitledui/icons";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { LibraryToggle } from "./library-toggle";
import { TasksToggle } from "./tasks-toggle";
import type { SidePanelKind } from "@/web/hooks/use-layout-state";

export interface ToggleButtonsProps {
  sidePanel: SidePanelKind | null;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  blocksAvailable?: boolean;
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
  blocksAvailable = false,
  disableActiveSidePanelToggle = false,
}: ToggleButtonsProps) {
  // Reports-only orgs collapse the toolbar to just the chat toggle.
  const reportsOnly = useReportsOnly();
  return (
    <>
      <HeaderTabButton
        title="Chat"
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
      {!reportsOnly && blocksAvailable && (
        <HeaderTabButton
          title="Blocks"
          icon={{ kind: "component", Component: TextInput }}
          active={sidePanel === "blocks"}
          disabled={disableActiveSidePanelToggle && sidePanel === "blocks"}
          className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          onClick={() => {
            track("agent_toolbar_toggled", {
              button: "blocks",
              next_state: sidePanel === "blocks" ? "closed" : "open",
            });
            toggleSidePanel("blocks");
          }}
        />
      )}
      {/* Tasks and Library are agent-independent overlays; hidden for
          reports-only orgs along with everything else but Chat. */}
      {!reportsOnly && (
        <>
          <TasksToggle />
          <LibraryToggle />
        </>
      )}
    </>
  );
}
