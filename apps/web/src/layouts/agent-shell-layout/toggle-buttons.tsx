import { MessageCircle01 } from "@untitledui/icons";
import { HeaderTabButton } from "@/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";
import type { SidePanelKind } from "@/hooks/use-layout-state";

export interface ChatToggleProps {
  sidePanel: SidePanelKind | null;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  /**
   * When true, the active chat toggle is disabled because closing it would
   * leave a blank content area (chat is the only open panel).
   */
  disableActiveSidePanelToggle?: boolean;
}

/**
 * Chat toggle — opens / closes the chat side panel. Rendered through the shared
 * HeaderTabButton so it stays pixel-identical to the Main panel tabs. It lives
 * in the chat panel's own header while the chat is open, and relocates into the
 * remaining panel's header when the chat is closed, so it never disappears.
 */
export function ChatToggle({
  sidePanel,
  toggleSidePanel,
  disableActiveSidePanelToggle = false,
}: ChatToggleProps) {
  const t = useT();
  return (
    <HeaderTabButton
      title={t("agentShellLayout.toggleButtons.chat")}
      icon={{ kind: "component", Component: MessageCircle01 }}
      active={sidePanel === "chat"}
      disabled={disableActiveSidePanelToggle && sidePanel === "chat"}
      // Distinctive icon — collapses with the system tabs at 768px of header.
      labelCollapse="sooner"
      className="h-10 md:h-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "chat",
          next_state: sidePanel === "chat" ? "closed" : "open",
        });
        toggleSidePanel("chat");
      }}
    />
  );
}
