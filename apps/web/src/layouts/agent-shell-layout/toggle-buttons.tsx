import {
  AlignLeft01,
  AlignRight01,
  LayoutRight,
  MessageCircle01,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
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

/**
 * A panel collapse control — the pair of chevron-into-bar buttons that bracket
 * the workspace under the first-class navigation: the left one lives at the
 * start of the MAIN header and hides/shows the chat, the right one lives at the
 * end of the CHAT header and hides/shows the main panel.
 *
 * Deliberately a plain icon button, not a HeaderTabButton: these are chrome for
 * the panel itself, not one of its views, so they never take the tab's active
 * pill styling.
 */
export function PanelCollapseToggle({
  side,
  open,
  disabled,
  onToggle,
}: {
  side: "left" | "right";
  open: boolean;
  /** True when collapsing would leave no panel showing at all. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const label = open
    ? side === "left"
      ? t("agentShellLayout.toggleButtons.hideChat")
      : t("agentShellLayout.toggleButtons.hidePanel")
    : side === "left"
      ? t("agentShellLayout.toggleButtons.showChat")
      : t("agentShellLayout.toggleButtons.showPanel");
  const Icon =
    side === "right" ? LayoutRight : open ? AlignLeft01 : AlignRight01;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            track("agent_toolbar_toggled", {
              button: side === "left" ? "chat" : "main",
              next_state: open ? "closed" : "open",
            });
            onToggle();
          }}
          className="size-7 rounded-md disabled:opacity-40"
        >
          <Icon size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
