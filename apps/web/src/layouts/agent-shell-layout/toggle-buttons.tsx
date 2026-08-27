import { AlignLeft01, AlignRight01, LayoutRight } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

/**
 * A panel collapse control — the pair of chevron-into-bar buttons that bracket
 * the workspace: the left one lives at the start of the MAIN header and
 * hides/shows the chat, the right one lives at the end of the CHAT header and
 * hides/shows the main panel.
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
